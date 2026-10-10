using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddShareGranteeTagsAndSharedBy : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "GranteeTags",
                table: "Shares",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "SharedByUserId",
                table: "Shares",
                type: "INTEGER",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "GranteeTags",
                table: "Shares");

            migrationBuilder.DropColumn(
                name: "SharedByUserId",
                table: "Shares");
        }
    }
}
