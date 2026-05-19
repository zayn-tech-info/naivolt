"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { formatCurrency, formatDate, statusColor } from "@/lib/utils";
import AdminLayout from "@/components/Layout";
import { ChevronRight, Search } from "lucide-react";

interface Transaction {
  _id: string;
  coin: string;
  network: string;
  amountCrypto: number;
  amountNaira: number;
  status: string;
  createdAt: string;
  user?: { name: string; email: string };
}

const TABS = ["all", "pending", "processing", "paid", "rejected"] as const;
type Tab = (typeof TABS)[number];

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

export default function TransactionsPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, isError } = useQuery<Transaction[]>({
    queryKey: ["admin-transactions", activeTab],
    queryFn: () =>
      api
        .get("/admin/transactions", {
          params: activeTab !== "all" ? { status: activeTab } : {},
        })
        .then((r) => r.data.data),
  });

  const filtered = (data ?? []).filter((tx) => {
    const q = search.toLowerCase();
    return (
      !q ||
      tx._id.toLowerCase().includes(q) ||
      tx.user?.name.toLowerCase().includes(q) ||
      tx.user?.email.toLowerCase().includes(q) ||
      tx.coin.toLowerCase().includes(q)
    );
  });

  return (
    <AdminLayout title="Crypto Transactions">
      {/* Filter Tabs */}
      <div className="flex gap-1 p-1 bg-white rounded-xl border border-slate-200 shadow-sm w-fit mb-6">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-colors ${
              activeTab === tab
                ? "bg-green-500 text-white"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Search + Table Card */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by user, coin, or ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>
          <span className="text-sm text-slate-400">{filtered.length} records</span>
        </div>

        {isLoading ? (
          <Spinner />
        ) : isError ? (
          <div className="px-6 py-10 text-center text-red-600 text-sm">
            Failed to load transactions. Please try again.
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-10 text-center text-slate-400 text-sm">No transactions found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 uppercase tracking-wide bg-slate-50 border-b border-slate-100">
                  <th className="px-6 py-3 font-medium">ID</th>
                  <th className="px-6 py-3 font-medium">User</th>
                  <th className="px-6 py-3 font-medium">Coin</th>
                  <th className="px-6 py-3 font-medium">Crypto Amount</th>
                  <th className="px-6 py-3 font-medium">NGN Amount</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((tx) => (
                  <tr
                    key={tx._id}
                    onClick={() => router.push(`/transactions/${tx._id}`)}
                    className="hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <td className="px-6 py-4 font-mono text-xs text-slate-500">{tx._id.slice(-8)}</td>
                    <td className="px-6 py-4">
                      <p className="font-medium text-slate-800">{tx.user?.name ?? "—"}</p>
                      <p className="text-xs text-slate-400">{tx.user?.email ?? ""}</p>
                    </td>
                    <td className="px-6 py-4 font-semibold text-slate-900">
                      {tx.coin}
                      {tx.network && (
                        <span className="ml-1 text-xs font-normal text-slate-400">({tx.network})</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-slate-700">{tx.amountCrypto}</td>
                    <td className="px-6 py-4 font-medium text-slate-900">{formatCurrency(tx.amountNaira)}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${statusColor(tx.status)}`}>
                        {tx.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-500 text-xs">{formatDate(tx.createdAt)}</td>
                    <td className="px-6 py-4 text-slate-400">
                      <ChevronRight size={16} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
