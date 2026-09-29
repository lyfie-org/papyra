using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class MultipleAuthenticatorsAndDeviceSessions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {

            migrationBuilder.AddColumn<string>(
                name: "DeviceHash",
                table: "UserSessions",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "UserAuthenticators",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    UserId = table.Column<int>(type: "INTEGER", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    Secret = table.Column<string>(type: "TEXT", nullable: false),
                    LastStep = table.Column<long>(type: "INTEGER", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    LastUsedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserAuthenticators", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_UserAuthenticators_UserId",
                table: "UserAuthenticators",
                column: "UserId");

            // Each account's one authenticator becomes its first row (the secret is
            // already encrypted with the same data-protection purpose).
            migrationBuilder.Sql(
                "INSERT INTO UserAuthenticators (UserId, Name, Secret, LastStep, CreatedUtc, LastUsedUtc) " +
                "SELECT Id, 'Authenticator app', TotpSecret, TotpLastStep, COALESCE(TotpEnabledUtc, CURRENT_TIMESTAMP), NULL " +
                "FROM Users WHERE TotpSecret IS NOT NULL");

            // Start the signed-in devices list fresh: rows from before sessions were
            // tied to a browser were duplicates (every page load adopted the old cookie).
            migrationBuilder.Sql("DELETE FROM UserSessions");

            migrationBuilder.DropColumn(
                name: "TotpEnabledUtc",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "TotpLastStep",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "TotpSecret",
                table: "Users");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "UserAuthenticators");

            migrationBuilder.DropColumn(
                name: "DeviceHash",
                table: "UserSessions");

            migrationBuilder.AddColumn<DateTime>(
                name: "TotpEnabledUtc",
                table: "Users",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "TotpLastStep",
                table: "Users",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TotpSecret",
                table: "Users",
                type: "TEXT",
                nullable: true);
        }
    }
}
