export function PageSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="space-y-6 py-2">
      <div className="h-8 w-40 animate-pulse rounded-lg bg-slate-200/70 motion-reduce:animate-none" />
      <div className="h-32 animate-pulse rounded-2xl bg-white motion-reduce:animate-none" />
      <div className="space-y-3">
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            className="h-16 animate-pulse rounded-xl bg-white motion-reduce:animate-none"
          />
        ))}
      </div>
    </div>
  );
}
