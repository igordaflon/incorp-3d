using System.Globalization;

namespace Incorp3D.Web.Models;

// Formatação pt-BR fixa: o WASM pode não carregar os dados ICU de pt-BR conforme o idioma do navegador.
public static class Fmt
{
    private static readonly NumberFormatInfo PtBr = new() { NumberGroupSeparator = ".", NumberDecimalSeparator = "," };

    public static string Currency(decimal value) => "R$ " + value.ToString("N0", PtBr);

    public static string Area(double value) => value.ToString("0.##", PtBr) + " m²";
}
