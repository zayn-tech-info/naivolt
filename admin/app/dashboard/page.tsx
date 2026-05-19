"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, formatDate, statusColor } from "@/lib/utils";
import AdminLayout from "@/components/Layout";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Users, ArrowLeftRight, Clock, BadgeDollarSign, CheckCircle } from "lucide-react";

interface Stats {
  totalTransactions: number;
  totalUsers: number;
  pendingTransactions: number;
  totalVolume: number;
  paidTransactions: number;
}

interface Transaction {
  _id: string;
  coin: string;
  amountCrypto: number;
  amountNaira: number;
  status: string;
  createdAt: string;
  user?: { name: string; email: string };
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <svg className="animate-spin h-7 w-7 text-green-500" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
      </svg>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 flex items-center gap-4">
      <div className={`flex items-center justify-center w-12 h-12 rounded-xl ${color}`}>
        <Icon size={22} className="text-white" />
      </div>
      <div>
        <p className="text-sm text-slate-500">{label}</p>
        <p className="text-2xl font-bold text-slate-900 mt-0.5">{value}</p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const statsQuery = useQuery<Stats>({
    queryKey: ["admin-stats"],
    queryFn: () => api.get("/admin/stats").then((r) => r.data.data),
  });

  const txQuery = useQuery<Transaction[]>({
    queryKey: ["admin-transactions-all"],
    queryFn: () => api.get("/admin/transactions").then((r) => r.data.data),
  });

  const stats = statsQuery.data;
  const transactions = txQuery.data ?? [];
  const recent = transactions.slice(0, 10);

  const chartData = [
    { status: "Pending", count: stats?.pendingTransactions ?? 0, fill: "#eab308" },
    {
      status: "Paid",
      count: stats?.paidTransactions ?? 0,
      fill: "#22c55e",
    },
    {
      status: "Other",
      count:
        (stats?.totalTransactions ?? 0) -
        (stats?.pendingTransactions ?? 0) -
        (stats?.paidTransactions ?? 0),
      fill: "#94a3b8",
    },
  ];

  return (
    <AdminLayout title="Dashboard">
      {/* Stats Grid */}
      {statsQuery.isLoading ? (
        <Spinner />
      ) : statsQuery.isError ? (
        <div className="text-red-600 text-sm">Failed to load stats.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-5 mb-8">
          <StatCard
            label="Total Users"
            value={stats?.totalUsers ?? 0}
            icon={Users}
            color="bg-indigo-500"
          />
          <StatCard
            label="Total Transactions"
            value={stats?.totalTransactions ?? 0}
            icon={ArrowLeftRight}
            color="bg-slate-600"
          />
          <StatCard
            label="Pending"
            value={stats?.pendingTransactions ?? 0}
            icon={Clock}
            color="bg-yellow-500"
          />
          <StatCard
            label="Total Volume"
            value={formatCurrency(stats?.totalVolume ?? 0)}
            icon={BadgeDollarSign}
            color="bg-green-600"
          />
          <StatCard
            label="Paid"
            value={stats?.paidTransactions ?? 0}
            icon={CheckCircle}
            color="bg-green-500"
          />
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-8">
        {/* Bar Chart */}
        <div className="xl:col-span-1 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <h2 className="text-base font-semibold text-slate-800 mb-4">Transactions by Status</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} barSize={36}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="status" tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: "#64748b" }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13 }}
                cursor={{ fill: "#f8fafc" }}
              />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Recent Transactions */}
        <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-6">
          <h2 className="text-base font-semibold text-slate-800 mb-4">Recent Transactions</h2>
          {txQuery.isLoading ? (
            <Spinner />
          ) : txQuery.isError ? (
            <p className="text-red-600 text-sm">Failed to load transactions.</p>
          ) : recent.length === 0 ? (
            <p className="text-slate-400 text-sm">No transactions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wide border-b border-slate-100">
                    <th className="pb-3 pr-4 font-medium">User</th>
                    <th className="pb-3 pr-4 font-medium">Coin</th>
                    <th className="pb-3 pr-4 font-medium">Amount (NGN)</th>
                    <th className="pb-3 pr-4 font-medium">Status</th>
                    <th className="pb-3 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {recent.map((tx) => (
                    <tr key={tx._id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 pr-4 text-slate-700">
                        {tx.user?.name ?? "—"}
                        <span className="block text-xs text-slate-400">{tx.user?.email}</span>
                      </td>
                      <td className="py-3 pr-4 font-medium text-slate-800">{tx.coin}</td>
                      <td className="py-3 pr-4 text-slate-700">{formatCurrency(tx.amountNaira)}</td>
                      <td className="py-3 pr-4">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${statusColor(tx.status)}`}>
                          {tx.status}
                        </span>
                      </td>
                      <td className="py-3 text-slate-500 text-xs">{formatDate(tx.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
