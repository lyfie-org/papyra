using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddAccessRequests : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AccessRequests",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    OwnerId = table.Column<int>(type: "INTEGER", nullable: false),
                    NoteId = table.Column<string>(type: "TEXT", nullable: false),
                    RequesterUserId = table.Column<int>(type: "INTEGER", nullable: false),
                    Access = table.Column<string>(type: "TEXT", nullable: false),
                    Status = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ResolvedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AccessRequests", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AccessRequests_OwnerId_Status",
                table: "AccessRequests",
                columns: new[] { "OwnerId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_AccessRequests_RequesterUserId_OwnerId_NoteId",
                table: "AccessRequests",
                columns: new[] { "RequesterUserId", "OwnerId", "NoteId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AccessRequests");
        }
    }
}
