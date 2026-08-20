using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddAuthTokensAndNotificationPrefs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "NotifyOnMention",
                table: "Users",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "NotifyOnSecurity",
                table: "Users",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "NotifyOnShare",
                table: "Users",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "AuthTokens",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    TokenHash = table.Column<string>(type: "TEXT", nullable: false),
                    Kind = table.Column<string>(type: "TEXT", nullable: false),
                    UserId = table.Column<int>(type: "INTEGER", nullable: true),
                    Email = table.Column<string>(type: "TEXT", nullable: false),
                    Username = table.Column<string>(type: "TEXT", nullable: false),
                    Role = table.Column<string>(type: "TEXT", nullable: false),
                    ExpiresUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UsedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AuthTokens", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AuthTokens_TokenHash",
                table: "AuthTokens",
                column: "TokenHash",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AuthTokens");

            migrationBuilder.DropColumn(
                name: "NotifyOnMention",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "NotifyOnSecurity",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "NotifyOnShare",
                table: "Users");
        }
    }
}
