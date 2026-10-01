export default function HomeLoading() {
  return (
    <section aria-busy="true" aria-label="正在加载页面" className="space-y-5 py-6">
      <h1 className="text-2xl font-semibold">正在加载</h1>
      <div className="flex min-h-64 items-center justify-center rounded-2xl bg-emerald-50 text-sm text-emerald-800" role="status">
        正在打开页面…
      </div>
    </section>
  );
}
