"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import AdminLayout from "@/components/Layout";
import { Plus, Trash2, Edit2, X } from "lucide-react";

interface Country {
  code: string;
  name: string;
  currency: string;
  ratePerUnit: number;
}

interface Category {
  _id: string;
  name: string;
  slug: string;
  emoji: string;
  countries: Country[];
  isActive?: boolean;
}

type CategoryForm = {
  name: string;
  slug: string;
  emoji: string;
  countries: Country[];
};

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

function toSlug(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const emptyForm: CategoryForm = {
  name: "",
  slug: "",
  emoji: "",
  countries: [{ code: "", name: "", currency: "", ratePerUnit: 0 }],
};

export default function CategoriesPage() {
  const queryClient = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<CategoryForm>(emptyForm);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const { data, isLoading, isError } = useQuery<Category[]>({
    queryKey: ["admin-gift-card-categories"],
    queryFn: () => api.get("/admin/gift-card-categories").then((r) => r.data.data),
  });

  const createMutation = useMutation({
    mutationFn: (payload: CategoryForm) => api.post("/admin/gift-card-categories", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-gift-card-categories"] });
      setFeedback({ type: "success", message: "Category created successfully." });
      setShowModal(false);
      setForm(emptyForm);
      setEditId(null);
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setFeedback({ type: "error", message: axiosErr.response?.data?.message || "Failed to create category." });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: CategoryForm }) =>
      api.put(`/admin/gift-card-categories/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-gift-card-categories"] });
      setFeedback({ type: "success", message: "Category updated successfully." });
      setShowModal(false);
      setForm(emptyForm);
      setEditId(null);
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { data?: { message?: string } } };
      setFeedback({ type: "error", message: axiosErr.response?.data?.message || "Failed to update category." });
    },
  });

  function openCreate() {
    setEditId(null);
    setForm(emptyForm);
    setFeedback(null);
    setShowModal(true);
  }

  function openEdit(cat: Category) {
    setEditId(cat._id);
    setForm({
      name: cat.name,
      slug: cat.slug,
      emoji: cat.emoji,
      countries: cat.countries.length
        ? cat.countries
        : [{ code: "", name: "", currency: "", ratePerUnit: 0 }],
    });
    setFeedback(null);
    setShowModal(true);
  }

  function handleSubmit() {
    if (!form.name.trim() || !form.slug.trim()) return;
    const payload = { ...form };
    if (editId) {
      updateMutation.mutate({ id: editId, payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  function updateCountry(index: number, field: keyof Country, value: string | number) {
    setForm((prev) => {
      const countries = [...prev.countries];
      countries[index] = { ...countries[index], [field]: value };
      return { ...prev, countries };
    });
  }

  function addCountry() {
    setForm((prev) => ({
      ...prev,
      countries: [...prev.countries, { code: "", name: "", currency: "", ratePerUnit: 0 }],
    }));
  }

  function removeCountry(index: number) {
    setForm((prev) => ({
      ...prev,
      countries: prev.countries.filter((_, i) => i !== index),
    }));
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <AdminLayout title="Gift Card Categories">
      {/* Global feedback */}
      {feedback && !showModal && (
        <div
          className={`mb-5 px-4 py-3 rounded-lg text-sm ${
            feedback.type === "success"
              ? "bg-green-50 border border-green-200 text-green-700"
              : "bg-red-50 border border-red-200 text-red-700"
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Header Actions */}
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-slate-500">{data?.length ?? 0} categories configured</p>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        >
          <Plus size={16} />
          Add Category
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {isLoading ? (
          <Spinner />
        ) : isError ? (
          <div className="px-6 py-10 text-center text-red-600 text-sm">
            Failed to load categories.
          </div>
        ) : !data?.length ? (
          <div className="px-6 py-10 text-center text-slate-400 text-sm">
            No categories yet. Create the first one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 uppercase tracking-wide bg-slate-50 border-b border-slate-100">
                  <th className="px-6 py-3 font-medium">Category</th>
                  <th className="px-6 py-3 font-medium">Slug</th>
                  <th className="px-6 py-3 font-medium">Countries</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.map((cat) => (
                  <tr key={cat._id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl leading-none">{cat.emoji || "🎁"}</span>
                        <span className="font-medium text-slate-900">{cat.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs text-slate-500">{cat.slug}</td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {cat.countries.slice(0, 3).map((c) => (
                          <span
                            key={c.code}
                            className="inline-block px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs"
                          >
                            {c.code}
                          </span>
                        ))}
                        {cat.countries.length > 3 && (
                          <span className="inline-block px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-xs">
                            +{cat.countries.length - 3}
                          </span>
                        )}
                        {cat.countries.length === 0 && (
                          <span className="text-xs text-slate-400">None</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          cat.isActive !== false
                            ? "bg-green-100 text-green-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {cat.isActive !== false ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openEdit(cat)}
                          className="p-2 text-slate-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                          title="Edit"
                        >
                          <Edit2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm overflow-y-auto py-10 px-4">
          <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
              <h2 className="text-lg font-semibold text-slate-900">
                {editId ? "Edit Category" : "New Category"}
              </h2>
              <button
                onClick={() => { setShowModal(false); setFeedback(null); }}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="px-6 py-6 space-y-5">
              {feedback && (
                <div
                  className={`px-4 py-3 rounded-lg text-sm ${
                    feedback.type === "success"
                      ? "bg-green-50 border border-green-200 text-green-700"
                      : "bg-red-50 border border-red-200 text-red-700"
                  }`}
                >
                  {feedback.message}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">
                    Category Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      setForm((prev) => ({
                        ...prev,
                        name,
                        slug: editId ? prev.slug : toSlug(name),
                      }));
                    }}
                    placeholder="e.g. Amazon Gift Card"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  />
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Emoji</label>
                  <input
                    type="text"
                    value={form.emoji}
                    onChange={(e) => setForm((prev) => ({ ...prev, emoji: e.target.value }))}
                    placeholder="🎁"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">
                    Slug <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.slug}
                    onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value }))}
                    placeholder="amazon-gift-card"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent font-mono"
                  />
                </div>
              </div>

              {/* Countries */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="text-xs font-medium text-slate-600">Countries</label>
                  <button
                    onClick={addCountry}
                    className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 font-medium transition-colors"
                  >
                    <Plus size={12} />
                    Add Country
                  </button>
                </div>
                <div className="space-y-2">
                  {form.countries.map((country, i) => (
                    <div key={i} className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg border border-slate-200">
                      <input
                        type="text"
                        value={country.code}
                        onChange={(e) => updateCountry(i, "code", e.target.value.toUpperCase())}
                        placeholder="US"
                        maxLength={2}
                        className="w-14 px-2 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-center font-mono uppercase bg-white"
                      />
                      <input
                        type="text"
                        value={country.name}
                        onChange={(e) => updateCountry(i, "name", e.target.value)}
                        placeholder="United States"
                        className="flex-1 px-2 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent bg-white"
                      />
                      <input
                        type="text"
                        value={country.currency}
                        onChange={(e) => updateCountry(i, "currency", e.target.value.toUpperCase())}
                        placeholder="USD"
                        maxLength={3}
                        className="w-16 px-2 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent font-mono uppercase bg-white"
                      />
                      <input
                        type="number"
                        value={country.ratePerUnit || ""}
                        onChange={(e) => updateCountry(i, "ratePerUnit", parseFloat(e.target.value) || 0)}
                        placeholder="Rate (₦)"
                        className="w-24 px-2 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent bg-white"
                      />
                      <button
                        onClick={() => removeCountry(i)}
                        disabled={form.countries.length === 1}
                        className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-slate-400 mt-2">Code: ISO 2-letter, Currency: ISO 3-letter, Rate: NGN per unit</p>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100">
              <button
                onClick={() => { setShowModal(false); setFeedback(null); }}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={isSaving || !form.name.trim() || !form.slug.trim()}
                className="flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                {isSaving ? "Saving…" : editId ? "Save Changes" : "Create Category"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
