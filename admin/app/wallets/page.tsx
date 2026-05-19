"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import AdminLayout from "@/components/Layout";
import { Plus, Trash2, Wallet } from "lucide-react";

interface WalletAddress {
  _id: string;
  coin: string;
  address: string;
  createdAt?: string;
}

const COINS = ["USDT", "ETH", "BTC", "BNB", "SOL"] as const;

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

export default function WalletsPage() {
  const queryClient = useQueryClient();
  const [selectedCoin, setSelectedCoin] = useState<string>(COINS[0]);
  const [addressInput, setAddressInput] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const { data, isLoading, isError } = useQuery<WalletAddress[]>({
    queryKey: ["admin-wallet-addresses"],
    queryFn: () => api.get("/admin/wallet-addresses").then((r) => r.data.data),
  });

  const addMutation = useMutation({
    mutationFn: (payload: { coin: string; addresses: string[] }) =>
      api.post("/admin/wallet-addresses", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-wallet-addresses"] });
      setFeedback({ type: "success", message: "Addresses added successfully." });
      setAddressInput("");
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setFeedback({ type: "error", message: axiosErr.response?.data?.message || "Failed to add addresses." });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/wallet-addresses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-wallet-addresses"] });
      setFeedback({ type: "success", message: "Address deleted." });
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setFeedback({ type: "error", message: axiosErr.response?.data?.message || "Failed to delete address." });
    },
  });

  function handleAdd() {
    const addresses = addressInput
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean);
    if (!addresses.length) return;
    setFeedback(null);
    addMutation.mutate({ coin: selectedCoin, addresses });
  }

  // Group by coin
  const byCoin: Record<string, WalletAddress[]> = {};
  for (const w of data ?? []) {
    if (!byCoin[w.coin]) byCoin[w.coin] = [];
    byCoin[w.coin].push(w);
  }

  return (
    <AdminLayout title="Wallet Addresses">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Add Form */}
        <div className="xl:col-span-1">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 sticky top-24">
            <div className="flex items-center gap-2 mb-5">
              <Wallet size={18} className="text-green-500" />
              <h2 className="text-base font-semibold text-slate-800">Add Addresses</h2>
            </div>

            {feedback && (
              <div
                className={`mb-4 px-4 py-3 rounded-lg text-sm ${
                  feedback.type === "success"
                    ? "bg-green-50 border border-green-200 text-green-700"
                    : "bg-red-50 border border-red-200 text-red-700"
                }`}
              >
                {feedback.message}
              </div>
            )}

            <div className="mb-4">
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Coin</label>
              <select
                value={selectedCoin}
                onChange={(e) => setSelectedCoin(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent bg-white"
              >
                {COINS.map((coin) => (
                  <option key={coin} value={coin}>
                    {coin}
                  </option>
                ))}
              </select>
            </div>

            <div className="mb-4">
              <label className="block text-xs font-medium text-slate-600 mb-1.5">
                Addresses <span className="text-slate-400 font-normal">(one per line)</span>
              </label>
              <textarea
                rows={6}
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
                placeholder={"0xABC...\n0xDEF..."}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none font-mono"
              />
            </div>

            <button
              onClick={handleAdd}
              disabled={addMutation.isPending || !addressInput.trim()}
              className="w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
            >
              <Plus size={16} />
              {addMutation.isPending ? "Adding…" : "Add Addresses"}
            </button>
          </div>
        </div>

        {/* Addresses List */}
        <div className="xl:col-span-2 space-y-6">
          {isLoading ? (
            <Spinner />
          ) : isError ? (
            <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700 text-sm">
              Failed to load wallet addresses.
            </div>
          ) : Object.keys(byCoin).length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-10 text-center text-slate-400 text-sm">
              No wallet addresses configured yet. Add some using the form.
            </div>
          ) : (
            COINS.filter((coin) => byCoin[coin]?.length > 0).map((coin) => (
              <div key={coin} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-700 font-bold text-xs">
                      {coin.slice(0, 2)}
                    </span>
                    <span className="font-semibold text-slate-900">{coin}</span>
                  </div>
                  <span className="text-xs text-slate-400">{byCoin[coin].length} address{byCoin[coin].length !== 1 ? "es" : ""}</span>
                </div>
                <div className="divide-y divide-slate-50">
                  {byCoin[coin].map((wallet) => (
                    <div key={wallet._id} className="flex items-center gap-3 px-6 py-3 hover:bg-slate-50 transition-colors group">
                      <code className="flex-1 text-xs text-slate-600 font-mono break-all">
                        {wallet.address}
                      </code>
                      <button
                        onClick={() => { setFeedback(null); deleteMutation.mutate(wallet._id); }}
                        disabled={deleteMutation.isPending}
                        className="flex-shrink-0 p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                        title="Delete address"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
