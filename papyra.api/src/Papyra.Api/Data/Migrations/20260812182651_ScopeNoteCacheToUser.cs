using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class ScopeNoteCacheToUser : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropPrimaryKey(
                name: "PK_NoteCache",
                table: "NoteCache");

            migrationBuilder.AddColumn<string>(
                name: "UserId",
                table: "NoteCache",
                type: "TEXT",
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddPrimaryKey(
                name: "PK_NoteCache",
                table: "NoteCache",
                columns: new[] { "UserId", "Id" });

            // Existing rows predate the column and would all backfill to UserId ""
            // — orphans matching no tenant. The cold-boot reconciler prunes any
            // cached row it doesn't meet on disk, and pruning calls into the search
            // index, so leaving them would delete the Lucene documents the same
            // pass had just rebuilt. NoteCache is a disposable mirror of the
            // filesystem (the architecture's stated invariant), so emptying it is
            // free: the next cold boot repopulates every row from disk.
            migrationBuilder.Sql("DELETE FROM \"NoteCache\";");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropPrimaryKey(
                name: "PK_NoteCache",
                table: "NoteCache");

            migrationBuilder.DropColumn(
                name: "UserId",
                table: "NoteCache");

            migrationBuilder.AddPrimaryKey(
                name: "PK_NoteCache",
                table: "NoteCache",
                column: "Id");
        }
    }
}
