/**
 * Startseite – Platzhalter mit Styling.
 *
 * Tailwind ist jetzt aktiv, aber noch mit den Standardfarben. Die eigenen
 * Design-Tokens und die App-Shell folgen im nächsten Schritt.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-2 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
        Notebook
      </h1>
      <p className="text-neutral-500">Antworten nur aus deinen Quellen.</p>
    </main>
  );
}
