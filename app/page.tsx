/**
 * Startseite – Platzhalter mit eigenen Design-Tokens.
 *
 * Die Tokens aus app/globals.css sind jetzt verdrahtet; die App-Shell mit
 * Quellenleiste und Chat folgt im nächsten Schritt.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-2 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Notebook</h1>
      <p className="text-muted-foreground">Antworten nur aus deinen Quellen.</p>
    </main>
  );
}
