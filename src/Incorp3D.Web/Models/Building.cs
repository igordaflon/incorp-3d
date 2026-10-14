using System.Text.Json;
using System.Text.Json.Serialization;

namespace Incorp3D.Web.Models;

public enum UnitStatus
{
    [JsonStringEnumMemberName("available")] Available,
    [JsonStringEnumMemberName("sold")] Sold
}

public sealed record Broker(string Name, string Whatsapp);

public sealed record Typology(
    string Id,
    string Name,
    string View,
    double Area,
    int Bedrooms,
    int Suites,
    int Parking,
    decimal BasePrice,
    string Description,
    string FloorPlan,
    IReadOnlyList<string> Photos,
    IReadOnlyList<string> Highlights);

public sealed record UnitRecord(string Id, int Floor, int Position, string Typology, UnitStatus Status);

public sealed record BuildingData(
    string Name,
    string Tagline,
    string Address,
    int Floors,
    int UnitsPerFloor,
    Broker Broker,
    IReadOnlyList<Typology> Typologies,
    IReadOnlyList<UnitRecord> Units);

public sealed record Unit(string Id, int Floor, int Position, UnitStatus Status, Typology Typology, decimal Price)
{
    public bool IsAvailable => Status == UnitStatus.Available;
}

public sealed record Building(
    string Name,
    string Tagline,
    string Address,
    int Floors,
    int UnitsPerFloor,
    Broker Broker,
    IReadOnlyList<Unit> Units)
{
    public int AvailableCount => Units.Count(u => u.IsAvailable);
    public int SoldPercent => Units.Count == 0 ? 0 : (int)Math.Round(100.0 * (Units.Count - AvailableCount) / Units.Count);
}

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, UseStringEnumConverter = true)]
[JsonSerializable(typeof(BuildingData))]
internal sealed partial class AppJsonContext : JsonSerializerContext;
