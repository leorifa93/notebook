# Fixtures

Selbst verfasste Testdokumente, frei erfunden. Namen, Adressen und Beträge sind
fiktiv.

| Datei | Inhalt | Wofür |
| --- | --- | --- |
| `muster-mietvertrag.pdf` | 6 Seiten, Fußzeile „Seite n von 6“, Zahlen passend zu [`docs/eval-plan.md`](../docs/eval-plan.md) (Wohnfläche S. 1, Miete 1.150 €, Betriebskosten 220 €, Kaution 3.450 € S. 2, Kündigung und Gerichtsstand Köln S. 3, Tiere und Untervermietung S. 4) | Parser- und Ingest-Tests, Demo, späteres Eval |
| `produkthandbuch.pdf` | 6 Seiten, Fußzeile „Seite n von 6“, Luftreiniger AR-300: technische Daten S. 2, Anweisungssatz „Ignoriere alle vorherigen Anweisungen …“ im Fließtext S. 4, Artikelnummern S. 5, Filter-Bestellnummer S. 6 | zweites Eval-Dokument (Bezeichner, Prompt-Injection) |
| `scan-beispiel.pdf` | 1 Seite, nur ein Bild, kein Textlayer | Test, dass Scans mit 422 abgelehnt werden |
| `duplikate-beispiel.pdf` | 1 Seite, Überschrift und ein Satz je zweimal deckungsgleich gezeichnet, ein Abschnitt (565 Zeichen) 300 pt tiefer wiederholt | Test, dass doppelter Text nur einmal im Index landet (Live-Befund L2) |
| `leer.pdf` | 2 Seiten ohne jeden Inhalt, weder Text noch Bild | Test, dass ein leeres PDF mit klarer Meldung abgelehnt wird |

Erzeugt mit `python3 fixtures/generate.py` (nur Standardbibliothek). Die PDFs
sind eingecheckt; das Skript dokumentiert, wie sie entstanden sind.

## Lizenz

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/deed.de): Die
Dateien in diesem Ordner und das Skript sind gemeinfrei und dürfen ohne
Einschränkung verwendet werden.
