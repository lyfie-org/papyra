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
    private static readonly string[] SearchFields = ["title", "body", "tags"];

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

    // Upsert a note: delete-by-id then add (UpdateDocument) so re-indexing never
    // leaves a duplicate. Title is boosted; body is indexed but not stored (the
    // .md file holds the body — the index only needs it searchable).
    public void IndexNote(Note note)
    {
        if (string.IsNullOrEmpty(note.Id)) return;

        var doc = new Document
        {
            new StringField("id", note.Id, Field.Store.YES),
            new TextField("title", note.Title ?? string.Empty, Field.Store.YES) { Boost = 2f },
            new StringField("tags", string.Join(' ', note.Tags), Field.Store.YES),
            new TextField("body", note.Body ?? string.Empty, Field.Store.NO),
        };

        _writer.UpdateDocument(new Term("id", note.Id), doc);
        _writer.Commit();
    }

    public void RemoveNote(string id)
    {
        if (string.IsNullOrEmpty(id)) return;
        _writer.DeleteDocuments(new Term("id", id));
        _writer.Commit();
    }

    // Relevance-ranked search over title/body/tags. Returns id + title + score;
    // the snippet is built by the caller from the live body (body isn't stored).
    public IReadOnlyList<SearchHit> Search(string queryText, int max = 50)
    {
        if (string.IsNullOrWhiteSpace(queryText)) return [];

        // Near-real-time reader straight off the writer — sees just-committed docs.
        using var reader = DirectoryReader.Open(_writer, applyAllDeletes: true);
        var searcher = new IndexSearcher(reader);
        var query = ParseQuery(queryText);

        var hits = searcher.Search(query, max).ScoreDocs;
        var results = new List<SearchHit>(hits.Length);
        foreach (var h in hits)
        {
            var doc = searcher.Doc(h.Doc);
            results.Add(new SearchHit(doc.Get("id"), doc.Get("title") ?? string.Empty, h.Score));
        }
        return results;
    }

    // A ~150-char highlighted snippet for a query over a body string. Falls back to
    // a leading slice when the query terms aren't present in this body.
    public string BuildSnippet(string queryText, string body, int maxChars = 150)
    {
        if (string.IsNullOrWhiteSpace(body)) return string.Empty;
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
