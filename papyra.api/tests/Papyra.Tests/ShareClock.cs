using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Papyra.Api.Data;
using Papyra.Api.Models;

namespace Papyra.Tests;

// The API refuses to create a share that has already run out, so a test that
// needs an expired one makes a live share and then lets time pass on it here.
internal static class ShareClock
{
    public static Task ExpireLinkAsync(WebApplicationFactory<Program> factory, string token) =>
        ExpireAsync(factory, s => s.Token == token);

    public static Task ExpireGrantAsync(WebApplicationFactory<Program> factory, int shareId) =>
        ExpireAsync(factory, s => s.Id == shareId);

    public static Task ExpireAllAsync(WebApplicationFactory<Program> factory) =>
        ExpireAsync(factory, _ => true);

    private static async Task ExpireAsync(WebApplicationFactory<Program> factory, Func<Share, bool> which)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        foreach (var share in db.Shares.AsEnumerable().Where(which))
            share.ExpiresUtc = DateTime.UtcNow.AddHours(-1);
        await db.SaveChangesAsync();
    }
}
