using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Papyra.Api.Models;
using Papyra.Api.Storage;
using static Papyra.Tests.JournalEndpointsTests;

namespace Papyra.Tests;

/// <summary>Journal-scoped keys, locked entries, and everything that could silently lose or leak a diary.</summary>
public sealed class JournalSecurityTests
{
    private const string Pw = "hunter2!";

    // ── Scoped API keys ──────────────────────────────────────────────────────────

    [Fact]
    public Task AJournalKey_ReachesTheJournal_AndNothingElse() => WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Groceries", null, null, false, false, "milk"));
        var token = await NewKeyAsync(app, "journal");
        Assert.StartsWith("papyra_j_", token);
        var key = KeyClient(app, token);

        // The journal, yes.
        Assert.Equal(HttpStatusCode.OK, (await key.GetAsync("/api/journal/today")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await key.GetAsync($"/api/journal?from={app.Day(3)}&to={app.Today}")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await key.GetAsync("/api/journal/stats")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PutDay(key, app.Today, new { body = "logged by a script", mood = 3 })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await key.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "and one more" })).StatusCode);
        // …a past day that has no entry yet (back-fill), but never a future one.
        Assert.Equal(HttpStatusCode.OK, (await PutDay(key, app.Day(9), new { body = "back-filled" })).StatusCode);
        Assert.Equal((HttpStatusCode)422, (await PutDay(key, DateOnly.Parse(app.Today).AddDays(1).ToString("yyyy-MM-dd"), new { body = "x" })).StatusCode);

        // Nothing else — deny by default, whatever the route.
        foreach (var (method, url) in new[]
        {
            ("GET", "/api/notes"), ("GET", "/api/notes/n1"), ("GET", $"/api/notes/journal-{app.Today}"),
            ("GET", "/api/search?q=milk"), ("GET", "/api/keys"), ("GET", "/api/export"), ("GET", "/api/settings"),
            ("GET", "/api/auth/me"), ("GET", "/api/media"), ("POST", $"/api/notes/journal-{app.Today}/trash"),
            ("DELETE", $"/api/notes/journal-{app.Today}"), ("GET", "/api/collections"), ("GET", "/api/webhooks"),
            ("POST", "/api/media/upload"),
        })
        {
            var res = await key.SendAsync(new HttpRequestMessage(new HttpMethod(method), url));
            Assert.True(res.StatusCode == HttpStatusCode.Forbidden, $"{method} {url} → {(int)res.StatusCode}");
            Assert.Equal("key_scope", (await Json(res)).GetProperty("code").GetString());
        }
        Assert.Equal(HttpStatusCode.OK, (await key.GetAsync("/health")).StatusCode);

        // Within the journal, a key still can't do the person's own things.
        Assert.Equal(HttpStatusCode.Forbidden, (await PutDay(key, app.Today, new { archived = true })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await PutDay(key, app.Today, new { secure = true })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await key.GetAsync("/api/journal/settings")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await key.PutAsJsonAsync("/api/journal/settings", new { dayStartsAt = 2 })).StatusCode);
        Assert.Contains("logged by a script", await File.ReadAllTextAsync(app.FileFor(app.Today)));
    });

    [Fact]
    public Task ANotesKey_CannotTouchTheJournal() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "zanzibar diary line" });
        await app.Client.PutAsJsonAsync("/api/notes/n1", new NoteWrite("Groceries", null, null, false, false, "zanzibar milk"));
        var key = KeyClient(app, await NewKeyAsync(app, "notes"));
        var id = $"journal-{app.Today}";

        foreach (var (method, url) in new[]
        {
            ("GET", "/api/journal/today"), ("GET", $"/api/journal/{app.Today}"), ("GET", "/api/journal"),
            ("GET", "/api/journal/stats"), ("GET", $"/api/notes/{id}"), ("GET", $"/api/notes/{id}/backlinks"),
            ("GET", $"/api/notes/{id}/snapshots"), ("GET", $"/api/notes/{id}/sections"), ("POST", $"/api/notes/{id}/trash"),
            ("DELETE", $"/api/notes/{id}"), ("GET", $"/api/comments?note={id}"),
        })
        {
            var res = await key.SendAsync(new HttpRequestMessage(new HttpMethod(method), url));
            Assert.True(res.StatusCode == HttpStatusCode.Forbidden, $"{method} {url} → {(int)res.StatusCode}");
        }
        Assert.Equal(HttpStatusCode.Forbidden, (await key.PutAsJsonAsync($"/api/notes/{id}", new NoteWrite("x", null, null, false, false, "x"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await key.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "x" })).StatusCode);

        // Its own notes are untouched, and a search through it never shows a diary line.
        Assert.Equal(HttpStatusCode.OK, (await key.GetAsync("/api/notes/n1")).StatusCode);
        var hits = await key.GetFromJsonAsync<JsonElement>("/api/search?q=zanzibar");
        Assert.Equal("n1", Assert.Single(hits.EnumerateArray()).GetProperty("id").GetString());
        Assert.Contains("zanzibar diary line", await File.ReadAllTextAsync(app.FileFor(app.Today)));
    });

    [Fact]
    public Task Keys_ListTheirScope_DefaultToNotes_AndStopWhenRevoked() => WithAppAsync(async app =>
    {
        // A key made without a scope — every key that predates scopes — is a notes key.
        var plain = await Json(await app.Client.PostAsJsonAsync("/api/keys", new { name = "old", code = await TestAuth.CodeAsync(app.Client) }));
        Assert.Equal("notes", plain.GetProperty("scope").GetString());
        Assert.StartsWith("papyra_", plain.GetProperty("token").GetString());
        Assert.DoesNotContain("papyra_j_", plain.GetProperty("token").GetString());

        var token = await NewKeyAsync(app, "journal");
        var key = KeyClient(app, token);
        Assert.Equal(HttpStatusCode.OK, (await key.GetAsync("/api/journal/today")).StatusCode);

        var list = await app.Client.GetFromJsonAsync<JsonElement>("/api/keys");
        var journalKey = list.EnumerateArray().Single(k => k.GetProperty("scope").GetString() == "journal");
        Assert.NotEqual(JsonValueKind.Null, journalKey.GetProperty("lastUsedUtc").ValueKind); // the first use stamped it

        Assert.Equal(HttpStatusCode.NoContent, (await app.Client.DeleteAsync($"/api/keys/{journalKey.GetProperty("id").GetInt32()}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await key.GetAsync("/api/journal/today")).StatusCode);

    });

    [Theory]
    [InlineData("journal", "journal")]
    [InlineData("JOURNAL", "journal")]
    [InlineData(" journal ", "journal")]
    [InlineData("notes", "notes")]
    [InlineData("", "notes")]
    [InlineData(null, "notes")]
    [InlineData("admin", "notes")]
    [InlineData("journal,notes", "notes")]
    public void AnUnknownScope_IsANotesKey_NeverAnAccidentalJournalKey(string? given, string expected) =>
        Assert.Equal(expected, ApiKeyScopes.Normalize(given));

    [Fact]
    public Task AKeyWrite_IsCreditedToTheKey_InHistory() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "morning, by hand" });
        var key = KeyClient(app, await NewKeyAsync(app, "journal"));
        Assert.Equal(HttpStatusCode.OK, (await key.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "added by the script" })).StatusCode);
        // The person's next edit makes the key's revision a version in the list.
        await PutDay(app.Client, app.Today, new { body = "morning, by hand\n\nadded by the script\n\nevening, by hand" });

        var versions = await app.Client.GetFromJsonAsync<JsonElement>($"/api/notes/journal-{app.Today}/snapshots");
        var credited = versions.EnumerateArray().SelectMany(v => v.GetProperty("editors").EnumerateArray().Select(e => e.GetString()));
        Assert.Contains(credited, name => name!.Contains("via script"));
    });

    [Fact]
    public Task ThroughAKey_AMentionStaysLiteral() => WithAppAsync(async app =>
    {
        await app.Client.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("bea", "Bea", "bea@x.y", Pw, Role: "User"));
        var key = KeyClient(app, await NewKeyAsync(app, "journal"));
        await key.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "ping @bea" });
        await Task.Delay(1000);
        using var scope = app.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Papyra.Api.Data.AppDbContext>();
        Assert.Empty(db.BlockGrants);
        Assert.Empty(db.Notifications.Where(n => n.Kind == "mention"));
    });

    // ── Locked entries ───────────────────────────────────────────────────────────

    [Fact]
    public Task ALockedEntry_IsSealedOnDisk_AndWithheldUntilUnlocked() => WithAppAsync(async app =>
    {
        var unlock = await UnlockAsync(app);
        var res = await PutDay(app.Client, app.Today, new { body = "the secret plan is zebracode", mood = 2, secure = true });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.True((await Json(res)).GetProperty("locked").GetBoolean());

        // On disk: ciphertext for the text, plaintext for what the calendar needs.
        var file = app.FileFor(app.Today);
        Assert.True(File.Exists(file), "a locked entry keeps its dated path");
        var disk = await File.ReadAllTextAsync(file);
        Assert.DoesNotContain("zebracode", disk);
        Assert.DoesNotContain("secret plan", disk);
        Assert.Contains("papyra-locked:v1:", disk);
        Assert.Contains("kind: journal", disk);
        Assert.Contains("mood: 2", disk);
        Assert.Contains("secure: true", disk);

        // Without the unlock token: metadata only.
        var plain = await Json(await app.Client.GetAsync($"/api/journal/{app.Today}"));
        Assert.True(plain.GetProperty("locked").GetBoolean());
        Assert.Equal(string.Empty, plain.GetProperty("body").GetString());
        Assert.Equal(2, plain.GetProperty("mood").GetInt32());
        Assert.True(plain.GetProperty("words").GetInt32() > 0);

        // With it: the text — and the reveal route every locked note uses works on a journal id.
        var open = new HttpRequestMessage(HttpMethod.Get, $"/api/journal/{app.Today}");
        open.Headers.Add("X-Unlock-Token", unlock);
        Assert.Equal("the secret plan is zebracode", (await Json(await app.Client.SendAsync(open))).GetProperty("body").GetString());
        var reveal = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/journal-{app.Today}/secure");
        reveal.Headers.Add("X-Unlock-Token", unlock);
        Assert.Equal("the secret plan is zebracode", (await Json(await app.Client.SendAsync(reveal))).GetProperty("body").GetString());

        // Search and the list never carry it; the streak still counts the day.
        Assert.Equal(0, (await app.Client.GetFromJsonAsync<JsonElement>("/api/search?q=zebracode")).GetArrayLength());
        var list = await Json(await app.Client.GetAsync($"/api/journal?from={app.Today}&to={app.Today}"));
        Assert.DoesNotContain("zebracode", list.ToString());
        Assert.Equal(1, (await Json(await app.Client.GetAsync("/api/journal/stats"))).GetProperty("current").GetInt32());
    });

    [Fact]
    public Task ALockedEntry_SurvivesTheSavePathsThatNeverSawItsBody() => WithAppAsync(async app =>
    {
        var unlock = await UnlockAsync(app);
        await PutDay(app.Client, app.Today, new { body = "keep this safe", secure = true });

        // A list-built save carries an empty body it never saw: the stored one stays.
        await PutDay(app.Client, app.Today, new { body = "", tags = new[] { "a" } });
        var reveal = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/journal-{app.Today}/secure");
        reveal.Headers.Add("X-Unlock-Token", unlock);
        Assert.Equal("keep this safe", (await Json(await app.Client.SendAsync(reveal))).GetProperty("body").GetString());

        // The open editor's autosave carries real text and no token: it must land, and stay locked.
        var save = await PutDay(app.Client, app.Today, new { body = "keep this safe, and more" });
        Assert.True((await Json(save)).GetProperty("locked").GetBoolean());
        reveal = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/journal-{app.Today}/secure");
        reveal.Headers.Add("X-Unlock-Token", unlock);
        Assert.Equal("keep this safe, and more", (await Json(await app.Client.SendAsync(reveal))).GetProperty("body").GetString());

        // A metadata-only change (mood) doesn't touch the text at all.
        await PutDay(app.Client, app.Today, new { mood = 5 });
        reveal = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/journal-{app.Today}/secure");
        reveal.Headers.Add("X-Unlock-Token", unlock);
        Assert.Equal("keep this safe, and more", (await Json(await app.Client.SendAsync(reveal))).GetProperty("body").GetString());
    });

    [Fact]
    public Task TakingTheLockOff_NeedsTheVaultOpen_AndLockingNeedsAPin() => WithAppAsync(async app =>
    {
        var unlock = await UnlockAsync(app);
        await PutDay(app.Client, app.Today, new { body = "private", secure = true });

        var refused = await PutDay(app.Client, app.Today, new { secure = false });
        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        Assert.Equal("locked", (await Json(refused)).GetProperty("code").GetString());
        Assert.Contains("secure: true", await File.ReadAllTextAsync(app.FileFor(app.Today)));

        var ok = await PutDay(app.Client, app.Today, new { secure = false }, unlock: unlock);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.False((await Json(ok)).GetProperty("locked").GetBoolean());
        Assert.Contains("private", await File.ReadAllTextAsync(app.FileFor(app.Today)));
    });

    [Fact]
    public Task AKey_NeverSeesOrWritesALockedEntry() => WithAppAsync(async app =>
    {
        await UnlockAsync(app);
        await PutDay(app.Client, app.Today, new { body = "zebracode", mood = 4, tags = new[] { "hidden" }, secure = true });
        var key = KeyClient(app, await NewKeyAsync(app, "journal"));

        Assert.Equal(HttpStatusCode.Locked, (await key.GetAsync($"/api/journal/{app.Today}")).StatusCode);
        Assert.Equal(HttpStatusCode.Locked, (await key.GetAsync("/api/journal/today")).StatusCode);
        Assert.Equal(HttpStatusCode.Locked, (await PutDay(key, app.Today, new { body = "overwrite" })).StatusCode);
        Assert.Equal(HttpStatusCode.Locked, (await key.PostAsJsonAsync($"/api/journal/{app.Today}/append", new { text = "tamper" })).StatusCode);
        var list = (await key.GetStringAsync($"/api/journal?from={app.Today}&to={app.Today}"));
        Assert.DoesNotContain("zebracode", list);
        Assert.DoesNotContain("hidden", list);
        var disk = await File.ReadAllTextAsync(app.FileFor(app.Today));
        Assert.DoesNotContain("overwrite", disk);
        Assert.DoesNotContain("tamper", disk);
    });

    [Fact]
    public Task LockNewEntries_LocksTheNextDayYouWrite() => WithAppAsync(async app =>
    {
        await UnlockAsync(app);
        Assert.Equal(HttpStatusCode.OK, (await app.Client.PutAsJsonAsync("/api/journal/settings", new { lockNewEntries = true })).StatusCode);
        var res = await PutDay(app.Client, app.Today, new { body = "born locked zebracode" });
        Assert.True((await Json(res)).GetProperty("locked").GetBoolean());
        Assert.DoesNotContain("zebracode", await File.ReadAllTextAsync(app.FileFor(app.Today)));
    });

    [Fact]
    public Task LockNewEntries_NeedsAVaultPin() => WithAppAsync(async app =>
    {
        // A second account has no PIN.
        await app.Client.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("bea", "Bea", "bea@x.y", Pw, Role: "User"));
        var bea = app.Factory.CreateClient();
        await bea.LoginAsync("bea", Pw);
        await TestAuth.CompleteForcedPasswordChangeAsync(bea, Pw);
        var refused = await bea.PutAsJsonAsync("/api/journal/settings", new { lockNewEntries = true });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal("pin_not_set", (await Json(refused)).GetProperty("code").GetString());
        var lockIt = await PutDay(bea, app.Today, new { body = "x", secure = true });
        Assert.Equal(HttpStatusCode.Conflict, lockIt.StatusCode);
        Assert.False(File.Exists(Path.Combine(app.Dir, "users", "2", "notes", "journal", app.Today[..4], app.Today.Substring(5, 2), app.Today + ".md")));
    });

    [Fact]
    public Task LockAll_SealsEveryOpenDay_LeavesTheBinAlone_AndCountsOnlyWhatItLocked() => WithAppAsync(async app =>
    {
        var unlock = await UnlockAsync(app);
        await PutDay(app.Client, app.Day(0), new { body = "today zebracode", mood = 4 });
        await PutDay(app.Client, app.Day(1), new { body = "yesterday zebracode" });
        await PutDay(app.Client, app.Day(2), new { body = "already locked zebracode", secure = true });
        await PutDay(app.Client, app.Day(3), new { body = "binned zebracode" });
        await app.Client.PostAsync($"/api/notes/journal-{app.Day(3)}/trash", null);

        var res = await app.Client.PostAsync("/api/journal/lock-all", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(2, (await Json(res)).GetProperty("locked").GetInt32());

        foreach (var i in new[] { 0, 1, 2 })
        {
            var disk = await File.ReadAllTextAsync(app.FileFor(app.Day(i)));
            Assert.DoesNotContain("zebracode", disk);
            Assert.Contains("secure: true", disk);
        }
        Assert.Contains("binned zebracode", await File.ReadAllTextAsync(app.FileFor(app.Day(3))));
        // The calendar still knows the mood and the size of a day it can no longer read.
        Assert.Contains("mood: 4", await File.ReadAllTextAsync(app.FileFor(app.Day(0))));
        // Nothing more to do the second time, and the words are still there with the PIN.
        Assert.Equal(0, (await Json(await app.Client.PostAsync("/api/journal/lock-all", null))).GetProperty("locked").GetInt32());
        var reveal = new HttpRequestMessage(HttpMethod.Get, $"/api/notes/journal-{app.Day(1)}/secure");
        reveal.Headers.Add("X-Unlock-Token", unlock);
        Assert.Equal("yesterday zebracode", (await Json(await app.Client.SendAsync(reveal))).GetProperty("body").GetString());
    });

    [Fact]
    public Task LockAll_NeedsAPin_AndIsNotAKeysToCall() => WithAppAsync(async app =>
    {
        await PutDay(app.Client, app.Today, new { body = "plain" });
        var key = KeyClient(app, await NewKeyAsync(app, "journal"));
        Assert.Equal(HttpStatusCode.Forbidden, (await key.PostAsync("/api/journal/lock-all", null)).StatusCode);

        await app.Client.PostAsJsonAsync("/api/auth/users", new ProvisionRequest("cai", "Cai", "cai@x.y", Pw, Role: "User"));
        var cai = app.Factory.CreateClient();
        await cai.LoginAsync("cai", Pw);
        await TestAuth.CompleteForcedPasswordChangeAsync(cai, Pw);
        var refused = await cai.PostAsync("/api/journal/lock-all", null);
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal("pin_not_set", (await Json(refused)).GetProperty("code").GetString());
        Assert.DoesNotContain("secure: true", await File.ReadAllTextAsync(app.FileFor(app.Today)));
    });

    private static async Task<string> UnlockAsync(App app)
    {
        var res = await app.Client.PostAsJsonAsync("/api/auth/vault/unlock", new { pin = TestAuth.VaultPin });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await Json(res)).GetProperty("unlockToken").GetString()!;
    }

    // ── Never lose a diary silently ──────────────────────────────────────────────

    private sealed class Vault : IDisposable
    {
        public const string Uid = "1";
        public readonly string Data = Path.Combine(Path.GetTempPath(), "papyra-jsafe-" + Guid.NewGuid().ToString("N"));
        public readonly VaultState State = new();
        public string Media => Path.Combine(Data, "users", Uid, "media");
        public string Notes => Path.Combine(Data, "users", Uid, "notes");
        public Vault() => Directory.CreateDirectory(Media);
        public void Dispose() { try { Directory.Delete(Data, recursive: true); } catch (IOException) { } }

        public string Photo(string name)
        {
            var path = Path.Combine(Media, name);
            File.WriteAllText(path, "x");
            var old = DateTime.UtcNow.AddDays(-30);
            File.SetCreationTimeUtc(path, old);
            File.SetLastWriteTimeUtc(path, old);
            return path;
        }

        public void Entry(string date, string body, bool trashed = false, bool secure = false) =>
            State.Upsert(Uid, Path.Combine(Notes, "journal", date[..4], date.Substring(5, 2), date + ".md"),
                new Note { Id = "journal-" + date, Title = date, Kind = "journal", Body = body, Trashed = trashed, Secure = secure });

        public OrphanPruneService Prune()
        {
            var config = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?> { ["Papyra:DataDir"] = Data }).Build();
            var env = new StubEnv();
            return new OrphanPruneService(
                State, new MediaReferences(State, config, env),
                new MediaMetaStore(config, env, new MemoryCache(new MemoryCacheOptions()), NullLogger<MediaMetaStore>.Instance),
                config, env, new JobRegistry(NullLogger<JobRegistry>.Instance), NullLogger<OrphanPruneService>.Instance);
        }
    }

    private sealed class StubEnv : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Papyra.Tests";
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    [Fact]
    public void AJournalOnlyPhoto_SurvivesTheOrphanSweep()
    {
        using var v = new Vault();
        var photo = v.Photo("beach.jpg");
        var voice = v.Photo("voice.m4a");
        var doc = v.Photo("ticket.pdf");
        var orphan = v.Photo("really-unused.png");
        v.Entry("2026-10-24", "Went to the beach ![[beach.jpg]]\n\n![[voice.m4a]] and ![[ticket.pdf]]");

        var (moved, _) = v.Prune().PruneOnce();

        Assert.Equal(1, moved);
        Assert.True(File.Exists(photo));
        Assert.True(File.Exists(voice));
        Assert.True(File.Exists(doc));
        Assert.False(File.Exists(orphan));
    }

    [Fact]
    public void ATrashedEntrysPhoto_IsKept_UntilTheEntryIsGone()
    {
        using var v = new Vault();
        var photo = v.Photo("keep.jpg");
        v.Entry("2026-10-24", "![[keep.jpg]]", trashed: true);
        Assert.Equal(0, v.Prune().PruneOnce().Moved);
        Assert.True(File.Exists(photo));
    }

    [Fact]
    public async Task TrashPurge_ExpiresATrashedEntryLikeAnyNote()
    {
        using var v = new Vault();
        var path = Path.Combine(v.Notes, "journal", "2026", "10", "2026-10-01.md");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, "x");
        v.State.Upsert(Vault.Uid, path, new Note
        {
            Id = "journal-2026-10-01", Title = "2026-10-01", Kind = "journal", Body = "x",
            Trashed = true, TrashedAt = DateTime.UtcNow.AddDays(-90),
        });
        var fresh = Path.Combine(v.Notes, "journal", "2026", "10", "2026-10-02.md");
        await File.WriteAllTextAsync(fresh, "y");
        v.State.Upsert(Vault.Uid, fresh, new Note
        {
            Id = "journal-2026-10-02", Title = "2026-10-02", Kind = "journal", Body = "y",
            Trashed = true, TrashedAt = DateTime.UtcNow,
        });

        using var host = new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.UseSetting("Papyra:DataDir", v.Data);
        });
        var purge = new TrashPurgeService(
            host.Services.GetRequiredService<IServiceScopeFactory>(), v.State, new WriteRing(new MemoryCache(new MemoryCacheOptions())),
            host.Services.GetRequiredService<SearchIndexService>(), new JobRegistry(NullLogger<JobRegistry>.Instance),
            NullLogger<TrashPurgeService>.Instance);
        Assert.Equal(1, await purge.PurgeOnceAsync(default));
        Assert.False(File.Exists(path));
        Assert.True(File.Exists(fresh));
    }

    [Fact]
    public Task RenamingANote_RewritesTheLinkInTheJournal_ButNeverAnAtName() => WithAppAsync(async app =>
    {
        await app.Client.PutAsJsonAsync("/api/notes/trip", new NoteWrite("Kyoto", null, null, false, false, "temples"));
        await PutDay(app.Client, app.Today, new { body = "Planning [[Kyoto]] with @someone.\n\nSee [[Kyoto]] again." });

        await app.Client.PutAsJsonAsync("/api/notes/trip", new NoteWrite("Kyoto trip", null, null, false, false, "temples"));

        var file = app.FileFor(app.Today);
        string text = string.Empty;
        for (var i = 0; i < 100; i++)
        {
            text = await File.ReadAllTextAsync(file);
            if (text.Contains("[[Kyoto trip]]")) break;
            await Task.Delay(100);
        }
        Assert.Contains("Planning [[Kyoto trip]] with @someone.", text);
        Assert.Contains("See [[Kyoto trip]] again.", text);
        Assert.Contains("kind: journal", text);
    });

    [Fact]
    public Task BackupAndRestore_CarryTheJournal_IncludingLockedDays() => WithAppAsync(async app =>
    {
        var unlock = await UnlockAsync(app);
        await PutDay(app.Client, app.Day(2), new { body = "plain day ![[pic.png]]", mood = 4 });
        await PutDay(app.Client, app.Day(1), new { body = "locked zebracode day", mood = 1, secure = true });

        var storage = app.Factory.Services.GetRequiredService<MarkdownStorageService>();
        var layout = new BackupLayout(storage, app.Factory.Services.GetRequiredService<IConfiguration>(),
            app.Factory.Services.GetRequiredService<IHostEnvironment>(),
            app.Factory.Services.GetRequiredService<LockedNoteCipher>(), app.Factory.Services.GetRequiredService<LockedNoteSealer>());

        var dest = Path.Combine(app.Dir, "backup-out");
        using (var scope = app.Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Papyra.Api.Data.AppDbContext>();
            var user = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.FirstAsync(db.Users);
            var counts = await layout.BuildAsync(user, db, dest, default, sealedVault: true);
            Assert.Equal(2, counts.Journal);
            Assert.Equal(0, counts.Notes);
            Assert.Equal(1, counts.Vault);
        }

        // Dated folders in journal/; the locked day travels sealed, in vault/.
        Assert.True(File.Exists(Path.Combine(dest, "journal", app.Day(2)[..4], app.Day(2).Substring(5, 2), app.Day(2) + ".md")));
        var sealedFile = Path.Combine(dest, "vault", "journal", app.Day(1)[..4], app.Day(1).Substring(5, 2), app.Day(1) + ".md");
        Assert.True(File.Exists(sealedFile));
        Assert.DoesNotContain("zebracode", await File.ReadAllTextAsync(sealedFile));
        var manifest = BackupLayout.ReadManifest(dest)!;
        Assert.Equal(3, manifest.Version);
        Assert.Equal(2, BackupLayout.Summarize(dest).Counts.Journal);

        // Wipe the live journal, then restore: both days come back, the locked one still locked.
        Directory.Delete(Path.Combine(app.Notes, "journal"), recursive: true);
        using (var scope = app.Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<Papyra.Api.Data.AppDbContext>();
            var user = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.FirstAsync(db.Users);
            await layout.ApplyAsync(dest, user, db, restoreProfile: false, default);
        }
        Assert.True(File.Exists(app.FileFor(app.Day(2))));
        Assert.True(File.Exists(app.FileFor(app.Day(1))));
        var restored = await File.ReadAllTextAsync(app.FileFor(app.Day(1)));
        Assert.Contains("secure: true", restored);
        Assert.Contains("kind: journal", restored);
        Assert.DoesNotContain("zebracode", restored);
        Assert.Contains("plain day", await File.ReadAllTextAsync(app.FileFor(app.Day(2))));
        Assert.NotNull(unlock);
    });

    [Fact]
    public Task AnOldBackup_WithoutAJournalFolder_StillSummarises() => WithAppAsync(async app =>
    {
        var old = Path.Combine(app.Dir, "v2-backup");
        Directory.CreateDirectory(Path.Combine(old, "notes"));
        await File.WriteAllTextAsync(Path.Combine(old, "notes", "a.md"), "---\nid: a\ntitle: A\n---\n\nhi");
        await File.WriteAllTextAsync(Path.Combine(old, BackupManifest.FileName),
            "{\"format\":\"papyra-backup\",\"version\":2,\"encrypted\":false,\"counts\":{\"notes\":1,\"todos\":0,\"vault\":0,\"media\":0}}");
        var summary = BackupLayout.Summarize(old);
        Assert.Equal(2, summary.Version);
        Assert.Equal(1, summary.Counts.Notes);
        Assert.Equal(0, summary.Counts.Journal);
    });
}
