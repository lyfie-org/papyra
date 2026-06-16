using Microsoft.EntityFrameworkCore;
using Papyra.Api.Data;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

// ── Relational cache (SQLite — disposable; filesystem is the authority) ──────
var dbPath = PapyraPaths.DbPath(builder.Configuration, builder.Environment.ContentRootPath);
Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlite($"Data Source={dbPath}"));

// Zero-trust markdown engine (filesystem is the authority; this is the only
// thing that serializes notes to/from .md).
builder.Services.AddSingleton<MarkdownStorageService>();

// ── Reactive observer: keep the in-memory vault in sync with the .md files ────
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<VaultState>();
builder.Services.AddSingleton<WriteRing>();
builder.Services.AddSingleton(sp => new VaultObserverOptions
{
    NotesDir = PapyraPaths.NotesDir(
        sp.GetRequiredService<IConfiguration>(),
        sp.GetRequiredService<IHostEnvironment>().ContentRootPath),
});
builder.Services.AddHostedService<VaultObserver>();

// ── Ephemeral full-text index (Lucene — disposable; rebuilt from the .md files) ─
builder.Services.AddSingleton<SearchIndexService>();

// Real-time push: the observer broadcasts metadata-only note events to clients.
builder.Services.AddSignalR();

var allowedOrigins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .Get<string[]>()
    ?? ["http://localhost:5173"];

builder.Services.AddCors(options => options.AddPolicy("AllowedOrigins", policy =>
    policy.WithOrigins(allowedOrigins)
          .AllowAnyHeader()
          .AllowAnyMethod()
          .AllowCredentials()));

var app = builder.Build();

// Run migrations on boot so papyra.db materializes before ports open.
using (var scope = app.Services.CreateScope())
{
    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.Migrate();
}

app.UseCors("AllowedOrigins");

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapOpenApi();

app.MapScalarApiReference(options =>
    options.WithTitle("Papyra API")
           .WithClassicLayout()
           .HideSearch()
           .HideDeveloperTools()
           .WithDocumentDownloadType(DocumentDownloadType.None)
           .DisableAgent()
           .WithCustomCss(".scalar-app .references-header { display: none !important; }"));

// ── Health ─────────────────────────────────────────────────────────────────
app.MapGet("/health", () => Results.Ok(new { status = "Healthy", app = "Papyra API" }))
    .ExcludeFromDescription();

// ── Notes CRUD ───────────────────────────────────────────────────────────────
// Reads serve the in-memory vault (no disk hit); writes go through the atomic
// markdown engine, logging the path in the Write-Ring so the watcher ignores the
// echo. Filesystem stays the source of truth — VaultState is just a mirror.
var notes = app.MapGroup("/api/notes");

notes.MapGet("/", (VaultState state) => Results.Ok(state.Snapshot()));

notes.MapPut("/{id}", async (
    string id,
    NoteWrite body,
    VaultState state,
    MarkdownStorageService storage,
    WriteRing writeRing,
    SearchIndexService search,
    VaultObserverOptions vault,
    CancellationToken ct) =>
{
    var path = state.PathFor(id) ?? Path.Combine(vault.NotesDir, $"{id}.md");
    var note = new Note
    {
        Id = id,
        Title = body.Title ?? string.Empty,
        Tags = body.Tags ?? [],
        Color = body.Color,
        Pinned = body.Pinned,
        Body = body.Body ?? string.Empty,
    };

    writeRing.Mark(path); // log self-write before touching disk (loop prevention)
    await storage.WriteAsync(path, note, ct);
    state.Upsert(path, note);
    search.IndexNote(note); // watcher skips our own write echo, so index here

    return Results.Ok(note);
});

notes.MapDelete("/{id}", (
    string id,
    VaultState state,
    WriteRing writeRing,
    SearchIndexService search) =>
{
    var path = state.PathFor(id);
    if (path is null) return Results.NotFound();

    writeRing.Mark(path); // watcher ignores the delete echo
    if (File.Exists(path)) File.Delete(path);
    state.Remove(path);
    search.RemoveNote(id); // watcher skips the echo, so drop from the index here

    return Results.NoContent();
});

// ── Search ────────────────────────────────────────────────────────────────────
// Relevance-ranked full-text search over the Lucene index. The index stores only
// metadata; snippets are highlighted against the live body in VaultState.
app.MapGet("/api/search", (string? q, SearchIndexService search, VaultState state) =>
{
    if (string.IsNullOrWhiteSpace(q)) return Results.Ok(Array.Empty<object>());

    var results = search.Search(q).Select(hit =>
    {
        var note = state.PathFor(hit.Id) is { } p && state.TryGet(p, out var n) ? n : null;
        var snippet = note is not null ? search.BuildSnippet(q, note.Body) : string.Empty;
        return new { id = hit.Id, title = hit.Title, snippet, score = hit.Score };
    }).ToArray();

    return Results.Ok(results);
});

app.MapHub<NotesHub>("/hubs/notes");

app.MapFallbackToFile("index.html");

app.Run();

// PUT payload for an upsert. Id comes from the route; the body carries metadata +
// markdown. Foreign frontmatter on an existing file is preserved by the engine.
public sealed record NoteWrite(
    string? Title,
    List<string>? Tags,
    string? Color,
    bool Pinned,
    string? Body);

// Makes the implicit top-level Program class visible to WebApplicationFactory in integration tests.
public partial class Program { }
