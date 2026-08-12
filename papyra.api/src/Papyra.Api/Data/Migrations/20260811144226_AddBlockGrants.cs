using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddBlockGrants : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "BlockGrants",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    SourceOwnerId = table.Column<int>(type: "INTEGER", nullable: false),
                    SourceNoteId = table.Column<string>(type: "TEXT", nullable: false),
                    BlockId = table.Column<string>(type: "TEXT", nullable: false),
                    GranteeUserId = table.Column<int>(type: "INTEGER", nullable: false),
                    SourceUsername = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    DismissedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BlockGrants", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_BlockGrants_GranteeUserId",
                table: "BlockGrants",
                column: "GranteeUserId");

            migrationBuilder.CreateIndex(
                name: "IX_BlockGrants_SourceOwnerId_SourceNoteId_BlockId_GranteeUserId",
                table: "BlockGrants",
                columns: new[] { "SourceOwnerId", "SourceNoteId", "BlockId", "GranteeUserId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "BlockGrants");
        }
    }
}
