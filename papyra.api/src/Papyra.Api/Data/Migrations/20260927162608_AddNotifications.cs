using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddNotifications : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Notifications",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    UserId = table.Column<int>(type: "INTEGER", nullable: false),
                    Kind = table.Column<string>(type: "TEXT", nullable: false),
                    ActorUserId = table.Column<int>(type: "INTEGER", nullable: false),
                    OwnerId = table.Column<int>(type: "INTEGER", nullable: false),
                    NoteId = table.Column<string>(type: "TEXT", nullable: false),
                    Access = table.Column<string>(type: "TEXT", nullable: true),
                    AccessRequestId = table.Column<int>(type: "INTEGER", nullable: true),
                    BlockGrantId = table.Column<int>(type: "INTEGER", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ReadUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    DismissedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Notifications", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Notifications_UserId_CreatedUtc",
                table: "Notifications",
                columns: new[] { "UserId", "CreatedUtc" });

            // Carry over what the old Inbox page showed, so upgrading doesn't
            // empty anyone's tray: live mentions, and access requests still
            // waiting on the owner.
            migrationBuilder.Sql(
                "INSERT INTO Notifications (UserId, Kind, ActorUserId, OwnerId, NoteId, BlockGrantId, CreatedUtc, ReadUtc) " +
                "SELECT GranteeUserId, 'mention', SourceOwnerId, SourceOwnerId, SourceNoteId, Id, CreatedUtc, ReadUtc " +
                "FROM BlockGrants WHERE DismissedUtc IS NULL;");
            migrationBuilder.Sql(
                "INSERT INTO Notifications (UserId, Kind, ActorUserId, OwnerId, NoteId, Access, AccessRequestId, CreatedUtc) " +
                "SELECT OwnerId, 'access_requested', RequesterUserId, OwnerId, NoteId, Access, Id, CreatedUtc " +
                "FROM AccessRequests WHERE Status = 'pending';");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Notifications");
        }
    }
}
