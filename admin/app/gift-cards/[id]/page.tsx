"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, formatDate, statusColor } from "@/lib/utils";
import AdminLayout from "@/components/Layout";
import { CheckCircle, XCircle, ArrowLeft, Eye } from "lucide-react";

interface GiftCardDetail {
  _id: string;
  categoryName: string;
  denomination: number;
  currency: string;
  amountNaira: number;
  cardCode?: string;
  cardPin?: string;
  proofImage?: string;
  status: string;
  createdAt: string;
  adminNote?: string;
  user?: { name: string; email: string };
  bankAccount?: { bankName: string; accountNumber: string; accountName: string };
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <svg className="animate-spin h-8 w-8 text-green-500" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
      </svg>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 py-3 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-500 sm:w-48 flex-shrink-0">{label}</span>
      <span className="text-sm font-medium text-slate-900 break-all">{value ?? "—"}</span>
    </div>
  );
}

export default function GiftCardDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [rejectNote, setRejectNote] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [imageExpanded, setImageExpanded] = useState(false);

  const { data: tx, isLoading, isError } = useQuery<GiftCardDetail>({
    queryKey: ["gift-card-transaction", id],
    queryFn: () => api.get(`/admin/gift-card-transactions/${id}`).then((r) => r.data.data),
    enabled: !!id,
  });

  const approveMutation = useMutation({
    mutationFn: () =>
      api.patch(`/admin/gift-card-transactions/${id}/approve`, { adminNote: note }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gift-card-transaction", id] });
      queryClient.invalidateQueries({ queryKey: ["admin-gift-card-transactions"] });
      setFeedback({ type: "success", message: "Gift card transaction approved." });
      setNote("");
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setFeedback({ type: "error", message: axiosErr.response?.data?.message || "Failed to approve." });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () =>
      api.patch(`/admin/gift-card-transactions/${id}/reject`, { adminNote: rejectNote }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gift-card-transaction", id] });
      queryClient.invalidateQueries({ queryKey: ["admin-gift-card-transactions"] });
      setFeedback({ type: "success", message: "Gift card transaction rejected." });
      setRejectNote("");
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setFeedback({ type: "error", message: axiosErr.response?.data?.message || "Failed to reject." });
    },
  });

  const canAct = tx?.status === "pending" || tx?.status === "processing";

  return (
    <AdminLayout title="Gift Card Detail">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 mb-6 transition-colors"
      >
        <ArrowLeft size={16} />
        Back to Gift Cards
      </button>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-red-700 text-sm">
          Failed to load gift card details.
        </div>
      ) : tx ? (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Main Info */}
          <div className="xl:col-span-2 space-y-6">
            {/* Header Card */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <p className="text-xs text-slate-400 font-mono mb-1">ID: {tx._id}</p>
                  <h2 className="text-xl font-bold text-slate-900">{tx.categoryName}</h2>
                  <p className="text-slate-500 text-sm mt-0.5">
                    {tx.currency} {tx.denomination?.toLocaleString()} &rarr; {formatCurrency(tx.amountNaira)}
                  </p>
                </div>
                <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium capitalize ${statusColor(tx.status)}`}>
                  {tx.status}
                </span>
              </div>

              <InfoRow label="Category" value={tx.categoryName} />
              <InfoRow label="Denomination" value={`${tx.currency} ${tx.denomination?.toLocaleString()}`} />
              <InfoRow label="Naira Value" value={formatCurrency(tx.amountNaira)} />
              <InfoRow label="Submitted At" value={formatDate(tx.createdAt)} />
              {tx.adminNote && <InfoRow label="Admin Note" value={tx.adminNote} />}
            </div>

            {/* Card Codes */}
            {(tx.cardCode || tx.cardPin) && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
                <h3 className="text-sm font-semibold text-slate-700 mb-4">Card Details</h3>
                {tx.cardCode && (
                  <div className="mb-3">
                    <p className="text-xs text-slate-500 mb-1">Card Code</p>
                    <code className="block text-sm font-mono text-slate-900 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 break-all">
                      {tx.cardCode}
                    </code>
                  </div>
                )}
                {tx.cardPin && (
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Card PIN</p>
                    <code className="block text-sm font-mono text-slate-900 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                      {tx.cardPin}
                    </code>
                  </div>
                )}
              </div>
            )}

            {/* Proof Image */}
            {tx.proofImage && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-700">Proof Image</h3>
                  <button
                    onClick={() => setImageExpanded(!imageExpanded)}
                    className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-green-600 transition-colors"
                  >
                    <Eye size={14} />
                    {imageExpanded ? "Collapse" : "Expand"}
                  </button>
                </div>
                <a href={tx.proofImage} target="_blank" rel="noopener noreferrer">
                  <img
                    src={tx.proofImage}
                    alt="Gift card proof"
                    className={`w-full object-contain rounded-lg border border-slate-200 cursor-pointer hover:opacity-90 transition-all ${
                      imageExpanded ? "max-h-screen" : "max-h-64"
                    }`}
                  />
                </a>
                <p className="text-xs text-slate-400 mt-2">Click image to open full size in new tab</p>
              </div>
            )}
          </div>

          {/* Side Info */}
          <div className="space-y-6">
            {/* User */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <h3 className="text-sm font-semibold text-slate-700 mb-4">Customer</h3>
              <InfoRow label="Name" value={tx.user?.name} />
              <InfoRow label="Email" value={tx.user?.email} />
            </div>

            {/* Bank Account */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
              <h3 className="text-sm font-semibold text-slate-700 mb-4">Bank Account</h3>
              <InfoRow label="Bank" value={tx.bankAccount?.bankName} />
              <InfoRow label="Account Number" value={tx.bankAccount?.accountNumber} />
              <InfoRow label="Account Name" value={tx.bankAccount?.accountName} />
            </div>

            {/* Actions */}
            {canAct && (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
                <h3 className="text-sm font-semibold text-slate-700 mb-4">Actions</h3>

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

                {/* Approve */}
                <div className="mb-4">
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">
                    Approval Note (optional)
                  </label>
                  <textarea
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Optional note…"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
                  />
                  <button
                    onClick={() => { setFeedback(null); approveMutation.mutate(); }}
                    disabled={approveMutation.isPending}
                    className="mt-2 w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
                  >
                    <CheckCircle size={16} />
                    {approveMutation.isPending ? "Approving…" : "Approve"}
                  </button>
                </div>

                {/* Reject */}
                <div className="border-t border-slate-100 pt-4">
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">
                    Rejection Reason <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    rows={2}
                    value={rejectNote}
                    onChange={(e) => setRejectNote(e.target.value)}
                    placeholder="Required: reason for rejection…"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent resize-none"
                  />
                  <button
                    onClick={() => { setFeedback(null); rejectMutation.mutate(); }}
                    disabled={rejectMutation.isPending || !rejectNote.trim()}
                    className="mt-2 w-full flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-red-300 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
                  >
                    <XCircle size={16} />
                    {rejectMutation.isPending ? "Rejecting…" : "Reject"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </AdminLayout>
  );
}
