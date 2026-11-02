import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

// Kept in its own file and lazy-loaded from App.tsx — recharts is sizeable
// and only needed once someone opens a document's "Charts" tab, so it
// shouldn't sit in the main bundle any more than pdfjs-dist or mammoth do.

const CHART_RAMP = ['#20211e', '#3d3f3a', '#5a5c56', '#787a73', '#96978f', '#b4b5ae']

export default function DocumentBarChart({ series }: { series: { label: string; value: number }[] }) {
  const data = series.map((point, index) => ({ ...point, fill: CHART_RAMP[index % CHART_RAMP.length] }))
  return (
    <div className="recharts-wrap">
      <ResponsiveContainer width="100%" height={Math.max(150, data.length * 44)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 36, bottom: 4, left: 4 }} barCategoryGap={14}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" width={96} tickLine={false} axisLine={false} tick={{ fill: '#777972', fontSize: 10 }} />
          <Tooltip
            cursor={{ fill: 'rgba(23,24,22,0.045)' }}
            contentStyle={{ fontSize: 11, border: '1px solid #e8e9e5', borderRadius: 4, boxShadow: '0 6px 18px rgba(20,20,18,.08)' }}
            labelStyle={{ color: '#343631', fontWeight: 600 }}
            formatter={(value) => [typeof value === 'number' ? value.toLocaleString() : String(value ?? ''), 'Value']}
          />
          <Bar dataKey="value" radius={[0, 3, 3, 0]} maxBarSize={18} label={{ position: 'right', fill: '#4e504b', fontSize: 9, fontWeight: 600 }}>
            {data.map((entry) => <Cell key={entry.label} fill={entry.fill} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
