using Lucene.Net.Analysis.Standard;
using Lucene.Net.Documents;
using Lucene.Net.Index;
using Lucene.Net.QueryParsers.Classic;
using Lucene.Net.Search;
using Lucene.Net.Store;
using Lucene.Net.Util;
using Papyra.Api.Models;

namespace Papyra.Api.Services;

public record SearchResult(string Id, string Snippet);

public sealed class IndexManager : IDisposable
{
    private const LuceneVersion LuceneVer = LuceneVersion.LUCENE_48;
    private static readonly string[] SearchFields = ["title", "tags", "content"];

    private readonly FSDirectory _directory;
    private readonly StandardAnalyzer _analyzer;
    private readonly IndexWriter _writer;

    public IndexManager(IConfiguration configuration)
        : this(configuration["Index:Directory"]
               ?? Path.Combine(AppContext.BaseDirectory, "index")) { }

    internal IndexManager(string indexDirectory)
    {
        System.IO.Directory.CreateDirectory(indexDirectory);
        _directory = FSDirectory.Open(new DirectoryInfo(indexDirectory));
        _analyzer = new StandardAnalyzer(LuceneVer);
        _writer = new IndexWriter(_directory, new IndexWriterConfig(LuceneVer, _analyzer));
        _writer.Commit(); // ensure index exists so readers can open it
    }

    public void UpdateIndex(Note note)
    {
        var doc = new Document();
        doc.Add(new StringField("id", note.Id, Field.Store.YES));
        doc.Add(new TextField("title", note.Title, Field.Store.YES));
        doc.Add(new TextField("tags", string.Join(" ", note.Tags), Field.Store.YES));
        doc.Add(new TextField("content", note.Content, Field.Store.YES));
        _writer.UpdateDocument(new Term("id", note.Id), doc);
        _writer.Commit();
    }

    public void RemoveFromIndex(string id)
    {
        _writer.DeleteDocuments(new Term("id", id));
        _writer.Commit();
    }

    public IReadOnlyList<SearchResult> Search(string queryText)
    {
        using var reader = DirectoryReader.Open(_directory);
        var searcher = new IndexSearcher(reader);
        var parser = new MultiFieldQueryParser(LuceneVer, SearchFields, _analyzer);
        Query query;
        try { query = parser.Parse(queryText); }
        catch (ParseException) { return []; }

        var hits = searcher.Search(query, n: 20);
        var results = new List<SearchResult>(hits.ScoreDocs.Length);
        foreach (var scoreDoc in hits.ScoreDocs)
        {
            var doc = searcher.Doc(scoreDoc.Doc);
            var id = doc.Get("id");
            var content = doc.Get("content") ?? "";
            var snippet = content.Length > 150 ? content[..150] + "…" : content;
            results.Add(new SearchResult(id, snippet));
        }
        return results;
    }

    public void Dispose()
    {
        _writer.Dispose();
        _analyzer.Dispose();
        _directory.Dispose();
    }
}
