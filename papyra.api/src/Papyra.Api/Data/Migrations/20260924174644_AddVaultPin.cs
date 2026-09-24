using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Papyra.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddVaultPin : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "RpId",
                table: "WebAuthnCredentials",
                type: "TEXT",
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<int>(
                name: "VaultPinFailures",
                table: "Users",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "VaultPinHash",
                table: "Users",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "VaultPinLockedUntilUtc",
                table: "Users",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "RpId",
                table: "WebAuthnCredentials");

            migrationBuilder.DropColumn(
                name: "VaultPinFailures",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "VaultPinHash",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "VaultPinLockedUntilUtc",
                table: "Users");
        }
    }
}
