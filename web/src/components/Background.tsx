/* 背景三层：暖纸底 → 一枚几乎静止的薰衣草弥散光斑 → 噪点纸感
   动机：保留温度但不抢夺证据数字的注意力 */
export default function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="animate-glow absolute -top-1/4 right-[-10%] h-[70vmax] w-[70vmax] rounded-full opacity-[0.16]"
        style={{
          background: 'radial-gradient(circle, #DCD3F7 0%, transparent 62%)',
          filter: 'blur(70px)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-multiply"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />
    </div>
  )
}
