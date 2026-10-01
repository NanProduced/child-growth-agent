export default function HomeLoading() {
  return (
    <section aria-busy="true" aria-label="正在加载全园成长地图" className="space-y-5 py-6">
      <h1 className="text-2xl font-semibold">全园成长地图</h1>
      <div className="flex min-h-64 items-center justify-center rounded-2xl bg-emerald-50 text-sm text-emerald-800" role="status">
        正在打开成长地图…
      </div>
    </section>
  );
}
