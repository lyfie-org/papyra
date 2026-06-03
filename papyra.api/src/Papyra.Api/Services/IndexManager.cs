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

public sealed class IndexManager : IHostedService, IDisposable
{
    private const LuceneVersion LuceneVer = LuceneVersion.LUCENE_48;
    private static readonly string[] SearchFields = ["title", "tags", "content"];

    private readonly MMapDirectory _directory;
    private readonly StandardAnalyzer _analyzer;
    private readonly IndexWriter _writer;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private bool _disposed;

    public IndexManager(IConfiguration configuration)
        : this(configuration["Index:Directory"]
               ?? Path.Combine(AppContext.BaseDirectory, "index")) { }

    internal IndexManager(string indexDirectory)
    {
        System.IO.Directory.CreateDirectory(indexDirectory);
        _directory = new MMapDirectory(new DirectoryInfo(indexDirectory));
        _analyzer = new StandardAnalyzer(LuceneVer);
        _writer = new IndexWriter(_directory, new IndexWriterConfig(LuceneVer, _analyzer));
        _writer.Commit();
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken)
    {
        Dispose();
        return Task.CompletedTask;
    }

    // Indexes a note by reading its full body from filePath (watcher passes the path).
    // IndexManager is responsible for the disk read so the watcher cache stays body-free.
    public void UpdateIndex(NoteMetadata meta, string filePath)
    {
        _gate.Wait();
        try
        {
            if (_disposed) return;

            var content = ReadBody(filePath);

            var doc = new Document();
            doc.Add(new StringField("id", meta.Id, Field.Store.YES));
            doc.Add(new TextField("title", meta.Title, Field.Store.YES));
            doc.Add(new TextField("tags", string.Join(" ", meta.Tags), Field.Store.YES));
            doc.Add(new TextField("content", content, Field.Store.YES));
            _writer.UpdateDocument(new Term("id", meta.Id), doc);
            _writer.Commit();
        }
        finally { _gate.Release(); }
    }

    private static string ReadBody(string filePath)
    {
        try
        {
            using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var sr = new StreamReader(fs);
            var raw    = sr.ReadToEnd().ReplaceLineEndings("\n");
            var lines  = raw.Split('\n');
            int close  = -1;
            for (int i = 1; i < lines.Length; i++)
                if (lines[i] == "---") { close = i; break; }
            return close >= 0 ? string.Join("\n", lines[(close + 1)..]) : "";
        }
        catch { return ""; }
    }

    public void RemoveFromIndex(string id)
    {
        _gate.Wait();
        try
        {
            if (_disposed) return;
            _writer.DeleteDocuments(new Term("id", id));
            _writer.Commit();
        }
        finally { _gate.Release(); }
    }

    public IReadOnlyList<SearchResult> Search(string queryText)
    {
        if (_disposed) return [];
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
        _gate.Wait();
        try
        {
            if (_disposed) return;
            _disposed = true;
            _writer.Dispose();
            _analyzer.Dispose();
            _directory.Dispose();
        }
        finally { _gate.Release(); }
    }
}
