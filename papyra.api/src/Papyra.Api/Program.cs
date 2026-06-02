using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.FileProviders;
using Papyra.Api.Hubs;
using Papyra.Api.Models;
using Papyra.Api.Services;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

// In dev, ContentRootPath = papyra.api/src/Papyra.Api/ — 3 levels up = repo root.
// In Docker (WORKDIR /app) → /app/../../../ = / → fallback = /data ✓
var repoRoot    = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "..", ".."));
var storageRoot = builder.Configuration["Storage:StorageRoot"] is { Length: > 0 } s
    ? s
    : Path.Combine(repoRoot, "data");

builder.Configuration["Storage:StorageRoot"] = storageRoot;

// _uploads holds images from the legacy global upload endpoint.
var uploadsDir = Path.Combine(storageRoot, "_uploads");
Directory.CreateDirectory(storageRoot);
Directory.CreateDirectory(uploadsDir);

builder.Services.Configure<KestrelServerOptions>(o =>
    o.Limits.MaxRequestBodySize = 16 * 1024 * 1024);

// Must match docker-compose stop_grace_period
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(30));

builder.Services.AddOpenApi();

var scalarLogoPath = Path.Combine(repoRoot, "assets", "favicon", "android-chrome-192x192.png");
var scalarLogoDataUrl = File.Exists(scalarLogoPath)
    ? $"data:image/png;base64,{Convert.ToBase64String(File.ReadAllBytes(scalarLogoPath))}"
    : string.Empty;

builder.Services.AddSignalR(o =>
{
    o.KeepAliveInterval     = TimeSpan.FromSeconds(15);
    o.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
});

var allowedOrigins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .Get<string[]>()
    ?? ["http://localhost:5173"];

builder.Services.AddCors(options => options.AddPolicy("AllowedOrigins", policy =>
    policy.WithOrigins(allowedOrigins)
          .AllowAnyHeader()
          .AllowAnyMethod()
          .AllowCredentials()));

builder.Services.AddSingleton<IMarkdownStorageService, MarkdownStorageService>();

// IndexManager must start before NoteWatcherService — shutdown runs in reverse,
// so the watcher cancels its debounce tasks before the index writer flushes.
builder.Services.AddSingleton<IndexManager>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<IndexManager>());

builder.Services.AddSingleton<NoteWatcherService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<NoteWatcherService>());

var app = builder.Build();

app.UseCors("AllowedOrigins");

// Serves the Papyra SPA from wwwroot/ (populated by the Docker build stage).
// No-ops in dev where wwwroot doesn't exist.
app.UseDefaultFiles();
app.UseStaticFiles();

static void SetMediaHeaders(Microsoft.AspNetCore.StaticFiles.StaticFileResponseContext ctx)
{
    var headers = ctx.Context.Response.Headers;
    headers.Append("X-Content-Type-Options", "nosniff");
    headers.Append("Cache-Control", "public, max-age=31536000, immutable");
    // SVG can embed <script> — force download instead of inline rendering
    if (ctx.File.Name.EndsWith(".svg", StringComparison.OrdinalIgnoreCase))
        headers.Append("Content-Disposition", "attachment");
}

// Legacy global uploads — keeps /media/{filename} URLs valid for existing notes.
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider       = new PhysicalFileProvider(uploadsDir),
    RequestPath        = "/media",
    OnPrepareResponse  = SetMediaHeaders,
});

// Per-note storage — serves [storageRoot]/{noteId}/media/{file} at /storage/…
// .md files are NOT served: FileExtensionContentTypeProvider has no MIME for .md
// so StaticFiles returns 404 for them without ServeUnknownFileTypes.
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider       = new PhysicalFileProvider(storageRoot),
    RequestPath        = "/storage",
    OnPrepareResponse  = SetMediaHeaders,
});

app.MapOpenApi();

app.MapScalarApiReference(options =>
    {
        options.WithTitle("Papyra API")
               .WithClassicLayout()
               .HideSearch()
               .HideDeveloperTools()
               .WithDocumentDownloadType(DocumentDownloadType.None)
               .DisableAgent()
               .WithCustomCss(".scalar-app .references-header { display: none !important; }");

        if (!string.IsNullOrEmpty(scalarLogoDataUrl))
            options.WithFavicon(scalarLogoDataUrl);
    });

app.MapHub<NotesHub>("/hubs/notes");

app.MapGet("/health", () => Results.Ok(new { status = "Healthy", app = "Papyra API" }))
    .ExcludeFromDescription();

app.MapGet("/notes", (NoteWatcherService watcher) =>
    Results.Ok(watcher.Notes.Values.Select(n => new
    {
        n.Id, n.Title, n.Tags, n.Pinned, n.Color,
    })))
    .WithName("GetNotes")
    .WithSummary("List all notes (metadata only, no Content)");

app.MapGet("/notes/{id}", (string id, NoteWatcherService watcher) =>
{
    var note = watcher.Notes.Values.FirstOrDefault(n => n.Id == id);
    return note is null ? Results.NotFound() : Results.Ok(note);
})
    .WithName("GetNote")
    .WithSummary("Get a single note by ID including Content");

app.MapPost("/notes", (CreateNoteRequest req, IMarkdownStorageService storage) =>
{
    var id = Guid.NewGuid().ToString();
    var note = new Note
    {
        Id      = id,
        Title   = req.Title,
        Tags    = req.Tags ?? [],
        Color   = req.Color ?? string.Empty,
    };
    var noteDir = Path.Combine(storageRoot, id);
    Directory.CreateDirectory(noteDir);
    File.WriteAllText(Path.Combine(noteDir, "note.md"), storage.SerializeNote(note));
    return Results.Created($"/notes/{id}", new { id });
})
    .WithName("CreateNote")
    .WithSummary("Create a new note");

app.MapPut("/notes/{id}", (string id, UpdateNoteRequest req, NoteWatcherService watcher, IMarkdownStorageService storage) =>
{
    var entry = watcher.Notes.FirstOrDefault(kv => kv.Value.Id == id);
    if (entry.Value is null) return Results.NotFound();

    var note = entry.Value;
    if (req.Title   is not null) note.Title   = req.Title;
    if (req.Tags    is not null) note.Tags    = req.Tags;
    if (req.Pinned.HasValue)     note.Pinned  = req.Pinned.Value;
    if (req.Color   is not null) note.Color   = req.Color;
    if (req.Content is not null) note.Content = req.Content;

    File.WriteAllText(entry.Key, storage.SerializeNote(note));
    return Results.NoContent();
})
    .WithName("UpdateNote")
    .WithSummary("Partially update a note");

app.MapDelete("/notes/{id}", (string id, NoteWatcherService watcher) =>
{
    var entry = watcher.Notes.FirstOrDefault(kv => kv.Value.Id == id);
    if (entry.Value is null) return Results.NotFound();

    // Delete the entire note directory (note.md + media/)
    var noteDir = Path.GetDirectoryName(entry.Key);
    if (noteDir is not null && Directory.Exists(noteDir))
        Directory.Delete(noteDir, recursive: true);
    else
        File.Delete(entry.Key);

    return Results.NoContent();
})
    .WithName("DeleteNote")
    .WithSummary("Delete a note and all its media");

// Per-note media upload — saves to [storageRoot]/{id}/media/ and returns /storage URL.
app.MapPost("/api/notes/{id}/media", async (string id, IFormFile file, NoteWatcherService watcher) =>
{
    if (!watcher.Notes.Values.Any(n => n.Id == id))
        return Results.NotFound();

    var allowedExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg" };

    var ext = Path.GetExtension(file.FileName);
    if (!allowedExtensions.Contains(ext))
        return Results.BadRequest(new { error = $"File type '{ext}' is not allowed." });

    var mediaDir = Path.Combine(storageRoot, id, "media");
    Directory.CreateDirectory(mediaDir);

    var fileName = $"{Guid.NewGuid()}{ext}";
    await using var stream = File.Create(Path.Combine(mediaDir, fileName));
    await file.CopyToAsync(stream);

    return Results.Ok(new { url = $"/storage/{id}/media/{fileName}" });
})
    .WithName("UploadNoteMedia")
    .WithSummary("Upload an image for a specific note; returns its public /storage URL")
    .DisableAntiforgery();

// Legacy global image upload — routes to [storageRoot]/_uploads/ for backwards compat.
app.MapPost("/api/upload/image", async (IFormFile file) =>
{
    var allowedExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg" };

    var ext = Path.GetExtension(file.FileName);
    if (!allowedExtensions.Contains(ext))
        return Results.BadRequest(new { error = $"File type '{ext}' is not allowed." });

    var fileName = $"{Guid.NewGuid()}{ext}";
    await using var stream = File.Create(Path.Combine(uploadsDir, fileName));
    await file.CopyToAsync(stream);

    return Results.Ok(new { url = $"/media/{fileName}" });
})
    .WithName("UploadImage")
    .WithSummary("Upload an image (legacy); returns its public /media URL")
    .DisableAntiforgery();

app.MapGet("/search", (string q, IndexManager indexManager, NoteWatcherService watcher) =>
{
    if (string.IsNullOrWhiteSpace(q))
        return Results.BadRequest(new { error = "Query parameter 'q' is required." });

    var hits = indexManager.Search(q);
    var response = hits
        .Select(hit =>
        {
            var note = watcher.Notes.Values.FirstOrDefault(n => n.Id == hit.Id);
            return note is null ? null : new
            {
                note.Id, note.Title, note.Tags, note.Pinned, note.Color, hit.Snippet,
            };
        })
        .Where(r => r is not null);

    return Results.Ok(response);
})
    .WithName("SearchNotes")
    .WithSummary("Full-text search across Title, Tags, and Content");

// Catches anything not matched by an API route — lets the SPA router handle deep links
app.MapFallbackToFile("index.html");

app.Run();

record CreateNoteRequest(string Title, List<string>? Tags, string? Color);
record UpdateNoteRequest(string? Title, List<string>? Tags, bool? Pinned, string? Color, string? Content);
