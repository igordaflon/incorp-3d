using System.Net.Http.Json;
using Incorp3D.Web.Models;

namespace Incorp3D.Web.Services;

public sealed class BuildingService(HttpClient http)
{
    private const decimal FloorPremium = 0.012m;
    private Building? _cache;

    public async Task<Building> GetAsync()
    {
        if (_cache is not null)
            return _cache;

        var data = await http.GetFromJsonAsync("data/building.json", AppJsonContext.Default.BuildingData)
            ?? throw new InvalidOperationException("data/building.json está vazio.");

        var typologies = data.Typologies.ToDictionary(t => t.Id);
        var units = data.Units
            .Select(u =>
            {
                var typology = typologies[u.Typology];
                return new Unit(u.Id, u.Floor, u.Position, u.Status, typology, PriceFor(typology, u.Floor));
            })
            .OrderByDescending(u => u.Floor)
            .ThenBy(u => u.Position)
            .ToList();

        return _cache = new Building(data.Name, data.Tagline, data.Address, data.Floors, data.UnitsPerFloor, data.Broker, units);
    }

    private static decimal PriceFor(Typology typology, int floor) =>
        Math.Round(typology.BasePrice * (1 + FloorPremium * (floor - 1)) / 1000m) * 1000m;
}
