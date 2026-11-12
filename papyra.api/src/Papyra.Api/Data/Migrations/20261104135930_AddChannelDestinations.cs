using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddChannelDestinations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ChannelDeliveries",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    DestinationId = table.Column<int>(type: "INTEGER", nullable: false),
                    UserId = table.Column<int>(type: "INTEGER", nullable: false),
                    Channel = table.Column<string>(type: "TEXT", nullable: false),
                    EventId = table.Column<string>(type: "TEXT", nullable: false),
                    Title = table.Column<string>(type: "TEXT", nullable: false),
                    Link = table.Column<string>(type: "TEXT", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    NextAttemptUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    Attempts = table.Column<int>(type: "INTEGER", nullable: false),
                    Status = table.Column<string>(type: "TEXT", nullable: false),
                    LastError = table.Column<string>(type: "TEXT", nullable: true),
                    DoneUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChannelDeliveries", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ChannelDestinations",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    UserId = table.Column<int>(type: "INTEGER", nullable: false),
                    Channel = table.Column<string>(type: "TEXT", nullable: false),
                    Kind = table.Column<string>(type: "TEXT", nullable: false),
                    Handle = table.Column<string>(type: "TEXT", nullable: false),
                    SecretSealed = table.Column<string>(type: "TEXT", nullable: true),
                    Label = table.Column<string>(type: "TEXT", nullable: false),
                    Verified = table.Column<bool>(type: "INTEGER", nullable: false),
                    Enabled = table.Column<bool>(type: "INTEGER", nullable: false),
                    PrivacyTier = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    LastOkUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    LastErrorUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    LastError = table.Column<string>(type: "TEXT", nullable: true),
                    ConsecutiveFailures = table.Column<int>(type: "INTEGER", nullable: false),
                    PausedUtc = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ChannelDestinations", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ChannelDeliveries_DestinationId",
                table: "ChannelDeliveries",
                column: "DestinationId");

            migrationBuilder.CreateIndex(
                name: "IX_ChannelDeliveries_Status_NextAttemptUtc",
                table: "ChannelDeliveries",
                columns: new[] { "Status", "NextAttemptUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ChannelDestinations_UserId_Channel",
                table: "ChannelDestinations",
                columns: new[] { "UserId", "Channel" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ChannelDeliveries");

            migrationBuilder.DropTable(
                name: "ChannelDestinations");
        }
    }
}
