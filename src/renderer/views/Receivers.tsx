export function ReceiversView(): React.JSX.Element {
  return (
    <section aria-label="Receivers" className="space-y-4">
      <h2 className="text-lg font-medium text-zinc-100">Receivers</h2>
      <p className="text-sm text-zinc-400">
        Wave 3: subscribe to any WAVE feed → render to virtual NDI source, virtual webcam,
        local file, or on-screen preview. Conferencing apps (Zoom / Teams / Meet) consume the
        virtual camera path.
      </p>
      <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
        Not yet wired. Tracked: tasks #165 (multiviewer) + #166 (conferencing bridge).
      </div>
    </section>
  );
}
