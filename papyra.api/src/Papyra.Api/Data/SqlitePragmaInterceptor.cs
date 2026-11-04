using System.Data.Common;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Papyra.Api.Data;

/// <summary>
/// Per-connection SQLite settings, applied each time EF opens the database.
///
/// Write-ahead logging lets readers carry on while the one writer works, which
/// matters here: every request and about two dozen background jobs share this
/// one file. <c>synchronous=NORMAL</c> is the pairing SQLite recommends with WAL
/// (it can lose the last few transactions on a power cut, never corrupt the file).
///
/// WAL needs shared memory, so it is unsafe on a network filesystem (NFS, SMB).
/// <c>PAPYRA_SQLITE_WAL=false</c> (<c>Features:SqliteWal</c>) switches back to the
/// rollback journal, and does so explicitly: the WAL setting is stored in the
/// file, so leaving it alone would keep WAL on.
/// </summary>
public sealed class SqlitePragmaInterceptor(bool wal) : DbConnectionInterceptor
{
    public const string FeatureKey = "Features:SqliteWal";

    private readonly string _sql = wal
        ? "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;"
        : "PRAGMA journal_mode=DELETE;";

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        if (IsReadOnly(connection)) return;
        using var cmd = connection.CreateCommand();
        cmd.CommandText = _sql;
        cmd.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(
        DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        if (IsReadOnly(connection)) return;
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = _sql;
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }

    // EF's existence check (Migrate, EnsureCreated) opens a read-only connection.
    // Changing the journal mode there fails with "attempt to write a readonly
    // database" whenever the file is not already in the wanted mode, which is
    // every existing install the first time it starts on WAL.
    private static bool IsReadOnly(DbConnection connection) =>
        connection is SqliteConnection sqlite
        && new SqliteConnectionStringBuilder(sqlite.ConnectionString).Mode == SqliteOpenMode.ReadOnly;
}
