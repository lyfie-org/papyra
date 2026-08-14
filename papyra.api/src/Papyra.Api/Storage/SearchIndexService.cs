using Lucene.Net.Analysis.Standard;
using Lucene.Net.Documents;
using Lucene.Net.Index;
using Lucene.Net.QueryParsers.Classic;
using Lucene.Net.Search;
using Lucene.Net.Search.Highlight;
using Lucene.Net.Store;
using Lucene.Net.Util;
using Papyra.Api.Models;

namespace Papyra.Api.Storage;

// Ephemeral full-text index over the vault (Lucene.NET). Disposable cache — the
// .md files are the authority; this dir can be deleted and rebuilt from disk.
// Exactly ONE IndexWriter lives for the app lifetime (a second one →
// LockObtainFailedException on write.lock). Registered as a singleton; disposed
// on shutdown.
public sealed class SearchIndexService : IDisposable
{
    private const LuceneVersion Version = LuceneVersion.LUCENE_48;
    private static readonly string[] SearchFields = ["title", "body", "tags", "extractedText"];

    private readonly FSDirectory _dir;
    private readonly StandardAnalyzer _analyzer;
    private readonly IndexWriter _writer;

    public SearchIndexService(IConfiguration config, IHostEnvironment env)
        : this(PapyraPaths.LuceneIndexDir(config, env.ContentRootPath)) { }

    // Test/direct seam: open the index at an explicit path.
    internal SearchIndexService(string indexDir)
    {
        System.IO.Directory.CreateDirectory(indexDir);
        _dir = FSDirectory.Open(indexDir);
        _analyzer = new StandardAnalyzer(Version);
        var cfg = new IndexWriterConfig(Version, _analyzer)
        {
            OpenMode = OpenMode.CREATE_OR_APPEND,
        };
        _writer = new IndexWriter(_dir, cfg);
        _writer.Commit(); // materialize segments so the first Search can open a reader
    }

    // Upsert a note for a tenant: delete-by-id then add (UpdateDocument) so
    // re-indexing never leaves a duplicate. The owning userId is stored on the doc
    // so Search can fence results to a single tenant. Title is boosted; body is
    // indexed but not stored (the .md file holds the body — the index only needs
    // it searchable).
    public void IndexNote(string userId, Note note)
    {
        if (string.IsNullOrEmpty(note.Id)) return;

        _writer.UpdateDocument(new Term("key", DocKey(userId, note.Id)), ToDocument(userId, note));
        _writer.Commit();
    }

    // Per-tenant nuclear rebuild: drop just this user's docs, then re-add them.
    // Deletes by the userId term (not DeleteAll) so one tenant's rebuild never
    // wipes another's index.
    public void RebuildUser(string userId, IEnumerable<Note> notes)
    {
        _writer.DeleteDocuments(new Term("userId", userId));
        foreach (var note in notes)
        {
            if (string.IsNullOrEmpty(note.Id)) continue;
            _writer.AddDocument(ToDocument(userId, note));
        }
        _writer.Commit();
    }

    /// <summary>
    /// The per-tenant identity of a note document. A note id is unique only
    /// *within* a vault — every user who has ever been @mentioned owns a note
    /// with id "Inbox" — so keying documents on the bare id made one tenant's
    /// note silently replace another's in the index. `:` is a safe separator:
    /// <see cref="PathGuard.IsValidNoteId"/> rejects it in note ids.
    /// </summary>
    private static string DocKey(string userId, string noteId) => $"{userId}:{noteId}";

    // Title is boosted; body is indexed but not stored (the .md file holds the
    // body — the index only needs it searchable). userId fences tenant results;
    // `key` is what identifies the document for update/delete.
    private static Document ToDocument(string userId, Note note) => new()
    {
        new StringField("key", DocKey(userId, note.Id), Field.Store.NO),
        new StringField("id", note.Id, Field.Store.YES),
        new StringField("userId", userId, Field.Store.YES),
        new TextField("title", note.Title ?? string.Empty, Field.Store.YES) { Boost = 2f },
        new StringField("tags", string.Join(' ', note.Tags), Field.Store.YES),
        new TextField("body", note.Body ?? string.Empty, Field.Store.NO),
    };

    // Scoped to the owning tenant: deleting by the bare id would also drop every
    // other tenant's note that happens to share it (e.g. "Inbox").
    public void RemoveNote(string userId, string id)
    {
        if (string.IsNullOrEmpty(id)) return;
        _writer.DeleteDocuments(new Term("key", DocKey(userId, id)));
        _writer.Commit();
    }

    // Index OCR text extracted from an image as its own document, tied to the parent
    // note via a stored `noteId`. Kept separate so re-indexing the note (which
    // rebuilds the note doc) never wipes the extracted text. The OCR text lives ONLY
    // here — if the index is dropped, re-scanning the media recreates it (zero-DB).
    public void IndexOcr(string userId, string ocrId, string noteId, string text)
    {
        if (string.IsNullOrEmpty(ocrId) || string.IsNullOrEmpty(noteId)) return;
        _writer.UpdateDocument(new Term("id", ocrId), new Document
        {
            new StringField("id", ocrId, Field.Store.YES),
            new StringField("userId", userId, Field.Store.YES),
            new StringField("noteId", noteId, Field.Store.YES),
            new TextField("extractedText", text ?? string.Empty, Field.Store.NO),
        });
        _writer.Commit();
    }

    // Relevance-ranked search over title/body/tags, fenced to one tenant. Returns
    // id + title + score; the snippet is built by the caller from the live body
    // (body isn't stored).
    public IReadOnlyList<SearchHit> Search(string userId, string queryText, int max = 50)
    {
        if (string.IsNullOrWhiteSpace(queryText)) return [];

        // Near-real-time reader straight off the writer — sees just-committed docs.
        using var reader = DirectoryReader.Open(_writer, applyAllDeletes: true);
        var searcher = new IndexSearcher(reader);

        // Fence to the caller's docs: userId MUST match, then the text query.
        var query = new BooleanQuery
        {
            { new TermQuery(new Term("userId", userId)), Occur.MUST },
            { ParseQuery(queryText), Occur.MUST },
        };

        var hits = searcher.Search(query, max).ScoreDocs;
        // A doc is either a note (its own id) or an OCR fragment (carries the parent
        // noteId). Resolve both to the note and collapse duplicates — an image match
        // and a body match for the same note surface once, at the best score.
        var byNote = new Dictionary<string, SearchHit>(StringComparer.Ordinal);
        foreach (var h in hits)
        {
            var doc = searcher.Doc(h.Doc);
            var noteId = doc.Get("noteId") ?? doc.Get("id");
            if (string.IsNullOrEmpty(noteId)) continue;
            var title = doc.Get("title") ?? string.Empty;

            if (byNote.TryGetValue(noteId, out var existing))
            {
                var bestTitle = string.IsNullOrEmpty(existing.Title) ? title : existing.Title;
                if (h.Score > existing.Score) byNote[noteId] = new SearchHit(noteId, bestTitle, h.Score);
                else if (existing.Title.Length == 0 && title.Length > 0) byNote[noteId] = existing with { Title = title };
            }
            else
            {
                byNote[noteId] = new SearchHit(noteId, title, h.Score);
            }
        }
        return byNote.Values.OrderByDescending(r => r.Score).ToList();
    }

    // A ~150-char highlighted snippet for a query over a body string. Falls back to
    // a leading slice when the query terms aren't present in this body.
    public string BuildSnippet(string queryText, string body, int maxChars = 150)
    {
        if (string.IsNullOrWhiteSpace(body)) return string.Empty;
        // Highlight the prose, not the raw markdown: the body carries the editor's
        // block anchors (`^p5fozaot`), which used to surface mid-snippet as
        // meaningless strings.
        body = PlainText.Flatten(body);
        if (body.Length == 0) return string.Empty;
        try
        {
            var highlighter = new Highlighter(
                new SimpleHTMLFormatter("<mark>", "</mark>"),
                new QueryScorer(ParseQuery(queryText)))
            {
                TextFragmenter = new SimpleFragmenter(maxChars),
            };
            using var stream = _analyzer.GetTokenStream("body", body);
            var fragment = highlighter.GetBestFragment(stream, body);
            if (!string.IsNullOrEmpty(fragment)) return fragment;
        }
        catch
        {
            // graceful fallback to a plain slice
        }
        return body.Length <= maxChars ? body : body[..maxChars] + "…";
    }

    // Parse across title/body/tags; if the user typed reserved query syntax that
    // fails to parse, retry with it escaped as literal text.
    private Query ParseQuery(string queryText)
    {
        var parser = new MultiFieldQueryParser(Version, SearchFields, _analyzer);
        try { return parser.Parse(queryText); }
        catch (ParseException) { return parser.Parse(QueryParserBase.Escape(queryText)); }
    }

    public void Dispose()
    {
        _writer?.Dispose();
        _analyzer?.Dispose();
        _dir?.Dispose();
    }
}

// A single search result: the note id, its title, and the relevance score.
public sealed record SearchHit(string Id, string Title, float Score);
