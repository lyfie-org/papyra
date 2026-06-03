using Papyra.Api.Models;

namespace Papyra.Api.Services;

// In-memory trigram inverted index over NoteMetadata titles and tags.
// Covers omni-bar typeahead only — body full-text search stays in Lucene.
// Fully reconstructable from the NoteMetadata dict at any time.
public sealed class FuzzyIndexService : IHostedService
{
    // trigram/token → set of noteIds
    private readonly Dictionary<string, HashSet<string>> _postings = new(StringComparer.Ordinal);
    // noteId → (title_lower, tag_lower[], tokens contributed)
    private readonly Dictionary<string, (string Title, string[] Tags, List<string> Tokens)> _noteData
        = new(StringComparer.Ordinal);
    private readonly ReaderWriterLockSlim _lock = new();

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public void Seed(IEnumerable<NoteMetadata> notes)
    {
        foreach (var note in notes)
            Upsert(note.Id, note.Title, note.Tags);
    }

    public void Upsert(string noteId, string title, IEnumerable<string> tags)
    {
        var titleLower = title.ToLowerInvariant();
        var tagsLower  = tags.Select(t => t.ToLowerInvariant().Trim()).Where(t => t.Length > 0).ToArray();
        var tokens     = BuildTokens(titleLower, tagsLower);

        _lock.EnterWriteLock();
        try
        {
            RemoveLockedById(noteId);
            _noteData[noteId] = (titleLower, tagsLower, tokens);
            foreach (var token in tokens)
            {
                if (!_postings.TryGetValue(token, out var set))
                    _postings[token] = set = new HashSet<string>(StringComparer.Ordinal);
                set.Add(noteId);
            }
        }
        finally { _lock.ExitWriteLock(); }
    }

    public void Remove(string noteId)
    {
        _lock.EnterWriteLock();
        try { RemoveLockedById(noteId); }
        finally { _lock.ExitWriteLock(); }
    }

    // Returns top-limit noteIds ranked by trigram match score.
    // A Levenshtein word-level pass is applied on the top-K candidates for queries ≥ 4 chars.
    public IReadOnlyList<string> Query(string q, int limit = 10)
    {
        if (string.IsNullOrWhiteSpace(q)) return [];

        var qLower    = q.ToLowerInvariant();
        var qTrigrams = Trigrams(qLower);
        // For short queries that don't produce trigrams, fall back to the literal token.
        if (qTrigrams.Count == 0 && qLower.Length > 0) qTrigrams.Add(qLower);

        Dictionary<string, int> scores;

        _lock.EnterReadLock();
        try
        {
            scores = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var tri in qTrigrams)
            {
                if (!_postings.TryGetValue(tri, out var set)) continue;
                foreach (var id in set)
                    scores[id] = scores.GetValueOrDefault(id) + 1;
            }
        }
        finally { _lock.ExitReadLock(); }

        if (scores.Count == 0) return [];

        // Rank by hit-count descending; take top-K for optional Levenshtein pass.
        var candidates = scores
            .OrderByDescending(kv => kv.Value)
            .Take(50)
            .ToList();

        // Levenshtein filter: for longer queries, accept only if at least one query word
        // fuzzy-matches a title word or exactly matches a tag token. Skipped for short queries.
        if (qLower.Length >= 4)
        {
            var qWords = qLower.Split(' ', StringSplitOptions.RemoveEmptyEntries);

            _lock.EnterReadLock();
            try
            {
                candidates = candidates.Where(kv =>
                {
                    if (!_noteData.TryGetValue(kv.Key, out var data)) return false;
                    var titleWords = data.Title.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    return qWords.Any(qw =>
                        // title word fuzzy match
                        titleWords.Any(tw => qw.Length >= 3 && tw.Length >= 3 && Levenshtein(qw, tw) <= 2) ||
                        // exact or fuzzy tag match
                        data.Tags.Any(tag =>
                            tag == qw ||
                            (qw.Length >= 3 && tag.Length >= 3 && Levenshtein(qw, tag) <= 2)));
                }).ToList();
            }
            finally { _lock.ExitReadLock(); }
        }

        return [.. candidates.Take(limit).Select(kv => kv.Key)];
    }

    // ── Internals ──────────────────────────────────────────────────────────────

    private static List<string> BuildTokens(string titleLower, string[] tagsLower)
    {
        var all = new HashSet<string>(StringComparer.Ordinal);
        // Title: exact words + trigrams (exact words support short-query lookup)
        foreach (var word in titleLower.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            all.Add(word);
            foreach (var tri in Trigrams(word)) all.Add(tri);
        }
        // Tags: exact token + trigrams
        foreach (var tag in tagsLower)
        {
            all.Add(tag);
            foreach (var tri in Trigrams(tag)) all.Add(tri);
        }
        return [.. all];
    }

    private static List<string> Trigrams(string text)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        if (text.Length >= 3)
        {
            for (int i = 0; i <= text.Length - 3; i++)
                set.Add(text[i..(i + 3)]);
        }
        return [.. set];
    }

    private void RemoveLockedById(string noteId)
    {
        if (!_noteData.Remove(noteId, out var data)) return;
        foreach (var tok in data.Tokens)
        {
            if (_postings.TryGetValue(tok, out var set))
            {
                set.Remove(noteId);
                if (set.Count == 0) _postings.Remove(tok);
            }
        }
    }

    private static int Levenshtein(string a, string b)
    {
        int m = a.Length, n = b.Length;
        if (m == 0) return n;
        if (n == 0) return m;

        Span<int> prev = stackalloc int[n + 1];
        Span<int> curr = stackalloc int[n + 1];
        for (int j = 0; j <= n; j++) prev[j] = j;
        for (int i = 1; i <= m; i++)
        {
            curr[0] = i;
            for (int j = 1; j <= n; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                curr[j] = Math.Min(Math.Min(curr[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            var tmp = prev; prev = curr; curr = tmp;
        }
        return prev[n];
    }
}
