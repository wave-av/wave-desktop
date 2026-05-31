export function MultiviewView(): React.JSX.Element {
  return (
    <section aria-label="Multiview" className="space-y-4">
      <h2 className="text-lg font-medium text-zinc-100">Multiview</h2>
      <p className="text-sm text-zinc-400">
        Wave 4: 4×4 / 9×9 / 16×16 grid with NDI + Dante audio meters. Click a tile to pin as
        program. Optional push to wave-realtime-edge as WebRTC for cloud directors.
      </p>
      <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
        Not yet wired. Tracked: task #165.
      </div>
    </section>
  );
}
