using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddBlockGrantText : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_BlockGrants_SourceOwnerId_SourceNoteId_BlockId_GranteeUserId",
                table: "BlockGrants");

            migrationBuilder.AddColumn<string>(
                name: "BlockText",
                table: "BlockGrants",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_BlockGrants_SourceOwnerId_SourceNoteId_BlockId_BlockText_GranteeUserId",
                table: "BlockGrants",
                columns: new[] { "SourceOwnerId", "SourceNoteId", "BlockId", "BlockText", "GranteeUserId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_BlockGrants_SourceOwnerId_SourceNoteId_BlockId_BlockText_GranteeUserId",
                table: "BlockGrants");

            migrationBuilder.DropColumn(
                name: "BlockText",
                table: "BlockGrants");

            migrationBuilder.CreateIndex(
                name: "IX_BlockGrants_SourceOwnerId_SourceNoteId_BlockId_GranteeUserId",
                table: "BlockGrants",
                columns: new[] { "SourceOwnerId", "SourceNoteId", "BlockId", "GranteeUserId" },
                unique: true);
        }
    }
}
