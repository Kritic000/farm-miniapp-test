import React, { useEffect, useMemo, useState } from "react";
import { API_URL } from "./config";

type Product = {
  id: string;
  category: string;
  name: string;
  unit: string;
  price: number;
  sort: number;
  description?: string;
  image?: string;
};

type CartItem = {
  product: Product;
  qty: number;
};

type TgUser = {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type OrderItem = {
  id?: string;
  name: string;
  unit?: string;
  price: number;
  qty: number;
  sum: number;
};

type Order = {
  orderId: string;
  createdAt: string;
  status: string;
  name?: string;
  phone?: string;
  total: number;
  delivery: number;
  grandTotal: number;
  items: OrderItem[];
  cancelReason?: string;
};

type Toast = { type: "error" | "success" | "info"; text: string } | null;

const PRODUCTS_CACHE_KEY = "farm_products_cache_v1";
const PRODUCTS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 минут
const LAST_PHONE_KEY = "farm_last_phone_v1";

// ✅ анти-дубли заказа на клиенте
const PENDING_ORDER_ID_KEY = "farm_pending_order_id_v1";

const DELIVERY_FEE = 200;
const FREE_DELIVERY_FROM = 2000;

function getTgUser(): TgUser | null {
  const w = window as any;
  const tg = w?.Telegram?.WebApp;
  const u = tg?.initDataUnsafe?.user;
  return u || null;
}

function money(n: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(n));
}

function normalizePhone(p: string) {
  return (p || "").replace(/\D+/g, "");
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function humanStatus(s: string) {
  const v = String(s || "").toLowerCase();
  if (v === "new") return "Новый";
  if (v === "accepted") return "Принят";
  if (v === "cooking" || v === "in_work") return "В работе";
  if (v === "delivering") return "Доставляется";
  if (v === "done" || v === "completed") return "Выполнен";
  if (v === "canceled" || v === "cancelled") return "Отменён";
  return s || "—";
}

function normalizeImagePath(img?: string): string | undefined {
  const s = String(img || "").trim();
  if (!s) return undefined;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return s;
  if (s.startsWith("public/")) return "/" + s.replace(/^public\//, "");
  return "/" + s;
}

function loadProductsCache(): { ts: number; products: Product[] } | null {
  try {
    const raw = localStorage.getItem(PRODUCTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.ts || !Array.isArray(parsed?.products)) return null;
    return { ts: parsed.ts, products: parsed.products };
  } catch {
    return null;
  }
}

function saveProductsCache(products: Product[]) {
  try {
    localStorage.setItem(
      PRODUCTS_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), products })
    );
  } catch {}
}

function loadLastPhone(): string {
  try {
    return localStorage.getItem(LAST_PHONE_KEY) || "";
  } catch {
    return "";
  }
}

function saveLastPhone(phone: string) {
  try {
    localStorage.setItem(LAST_PHONE_KEY, phone);
  } catch {}
}

async function fetchWithTimeout(
  input: RequestInfo,
  init: RequestInit & { timeoutMs?: number } = {}
) {
  const { timeoutMs = 25000, ...rest } = init;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...rest, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function makeOrderId() {
  const pending = sessionStorage.getItem(PENDING_ORDER_ID_KEY);
  if (pending) return pending;

  const id =
    (crypto as any)?.randomUUID?.() ||
    `oid_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  sessionStorage.setItem(PENDING_ORDER_ID_KEY, id);
  return id;
}

function clearPendingOrderId() {
  try {
    sessionStorage.removeItem(PENDING_ORDER_ID_KEY);
  } catch {}
}

export default function App() {
  const API_TOKEN = "Kjhytccb18@";

  const [loading, setLoading] = useState(true);
  const [loadingHint, setLoadingHint] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [toast, setToast] = useState<Toast>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>("Все");
  const [tab, setTab] = useState<"catalog" | "cart" | "checkout" | "orders">(
    "catalog"
  );

  const [cart, setCart] = useState<Record<string, CartItem>>({});

  const [address, setAddress] = useState("");
  const [comment, setComment] = useState("");

  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState(() => loadLastPhone());

  const [sending, setSending] = useState(false);

  // ✅ zoom
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);

  // orders
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState("");
  const [orders, setOrders] = useState<Order[]>([]);

  // ✅ cancel modal
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  // Telegram init
  useEffect(() => {
    const w = window as any;
    const tg = w?.Telegram?.WebApp;
    if (tg) {
      try {
        tg.ready();
        tg.expand();
      } catch {}
    }
  }, []);

  // toast auto close
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // save phone
  useEffect(() => {
    const p = phone.trim();
    if (p.length >= 6) saveLastPhone(p);
  }, [phone]);

  // load products: cache -> network
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const cached = loadProductsCache();
      const hasFreshCache = !!(
        cached && Date.now() - cached.ts < PRODUCTS_CACHE_TTL_MS
      );

      try {
        setLoading(true);
        setError("");
        setLoadingHint("");

        if (hasFreshCache && cached) {
          setProducts(cached.products);
          setLoading(false);
          setLoadingHint("Обновляем ассортимент…");
        }

        const url = `${API_URL}?action=products&ts=${Date.now()}`;
        const res = await fetchWithTimeout(url, {
          method: "GET",
          timeoutMs: 25000,
        });
        const data = await res.json();

        if (data?.error) throw new Error(data.error);

        const list: Product[] = (data.products || []).map((p: Product) => ({
          ...p,
          image: normalizeImagePath(p.image),
        }));

        if (cancelled) return;

        setProducts(list);
        saveProductsCache(list);

        setLoading(false);
        setLoadingHint("");
      } catch (e: any) {
        if (cancelled) return;

        if (e?.name === "AbortError" && hasFreshCache) {
          setLoading(false);
          setError("");
          setLoadingHint(
            "Сервер отвечает медленно. Показан сохранённый ассортимент."
          );
          return;
        }

        if (e?.name === "AbortError")
          setError("Сервер долго отвечает. Попробуйте ещё раз.");
        else setError(e?.message || "Ошибка загрузки товаров");

        setLoading(false);
        setLoadingHint("");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ✅ ВАЖНО: "Акции" есть в таблице в category, поэтому исключаем её из Set, а чип вставляем вручную.
  const categories = useMemo(() => {
    const set = new Set<string>();

    products.forEach((p) => {
      const cat = String(p.category || "").trim();
      if (!cat) return;

      if (cat.toLowerCase() === "акции") return; // чтобы не было дубля
      set.add(cat);
    });

    return ["Акции", "Все", ...Array.from(set)];
  }, [products]);

  // ✅ "Акции" = category строго "Акции"
  const filteredProducts = useMemo(() => {
    if (activeCategory === "Все") return products;

    if (activeCategory === "Акции") {
      return products.filter(
        (p) => String(p.category || "").trim().toLowerCase() === "акции"
      );
    }

    return products.filter((p) => p.category === activeCategory);
  }, [products, activeCategory]);

  const cartItems = useMemo(() => Object.values(cart), [cart]);

  const cartCount = useMemo(
    () => cartItems.reduce((s, it) => s + it.qty, 0),
    [cartItems]
  );

  const total = useMemo(
    () => cartItems.reduce((s, it) => s + it.qty * it.product.price, 0),
    [cartItems]
  );

  const delivery = useMemo(() => {
    if (total <= 0) return 0;
    return total < FREE_DELIVERY_FROM ? DELIVERY_FEE : 0;
  }, [total]);

  const grandTotal = useMemo(() => total + delivery, [total, delivery]);

  function addToCart(p: Product) {
    setCart((prev) => {
      const next = { ...prev };
      const cur = next[p.id];
      next[p.id] = { product: p, qty: (cur?.qty || 0) + 1 };
      return next;
    });
    setToast({ type: "info", text: "Добавлено в корзину" });
  }

  function setQty(productId: string, qty: number) {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[productId];
      else next[productId] = { ...next[productId], qty };
      return next;
    });
  }

  function qtyOf(productId: string) {
    return cart[productId]?.qty || 0;
  }

  function validateCheckout(): string | null {
    if (customerName.trim().length < 2) return "Укажи имя (минимум 2 символа).";
    if (phone.trim().length < 6) return "Укажи телефон (минимум 6 символов).";
    if (address.trim().length < 5)
      return "Укажи адрес доставки (минимум 5 символов).";
    if (cartItems.length === 0) return "Корзина пустая.";
    return null;
  }

  async function submitOrder() {
    const validationError = validateCheckout();
    if (validationError) {
      setToast({ type: "error", text: validationError });
      return;
    }

    const orderId = makeOrderId();
    const tg = getTgUser();

    const payload = {
      token: API_TOKEN,
      orderId,
      tg: tg || {},
      name: customerName.trim(),
      phone: phone.trim(),
      address: address.trim(),
      comment: comment.trim(),
      items: cartItems.map((it) => ({
        id: it.product.id,
        name: it.product.name,
        unit: it.product.unit,
        price: it.product.price,
        qty: it.qty,
        sum: it.qty * it.product.price,
      })),
      total,
      delivery,
      grandTotal,
    };

    try {
      setSending(true);

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (data?.error) throw new Error(data.error);

      setToast({
        type: "success",
        text: data?.duplicate
          ? "✅ Заказ уже был отправлен (повтор не записан)."
          : "✅ Заказ отправлен! Мы свяжемся для подтверждения.",
      });

      clearPendingOrderId();

      setCart({});
      setAddress("");
      setComment("");
      setCustomerName("");
      setTab("catalog");
    } catch (e: any) {
      setToast({
        type: "error",
        text: `Не удалось отправить заказ: ${e?.message || "Ошибка"}`,
      });
    } finally {
      setSending(false);
    }
  }

  async function loadMyOrders() {
    const tg = getTgUser();
    const tgUserId = tg?.id ? String(tg.id) : "";
    const phoneDigits = normalizePhone(phone);

    if (!tgUserId && phoneDigits.length < 6) {
      setOrders([]);
      setOrdersError(
        "Чтобы показать заказы, открой приложение из Telegram или укажи телефон (в оформлении)."
      );
      return;
    }

    try {
      setOrdersLoading(true);
      setOrdersError("");

      const url =
        `${API_URL}?action=orders` +
        `&token=${encodeURIComponent(API_TOKEN)}` +
        `&tgUserId=${encodeURIComponent(tgUserId)}` +
        `&phone=${encodeURIComponent(phoneDigits)}` +
        `&limit=30` +
        `&ts=${Date.now()}`;

      const res = await fetchWithTimeout(url, {
        method: "GET",
        timeoutMs: 25000,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (data?.error) throw new Error(data.error);

      const list: Order[] = Array.isArray(data.orders) ? data.orders : [];
      setOrders(list);
    } catch (e: any) {
      setOrdersError(e?.message || "Не удалось загрузить заказы");
    } finally {
      setOrdersLoading(false);
    }
  }

  // ✅ cancel order with reason
  async function cancelOrderRequest(orderId: string, reason: string) {
    const r = reason.trim();
    if (r.length < 3) {
      setToast({
        type: "error",
        text: "Укажи причину отмены (минимум 3 символа).",
      });
      return;
    }

    const tg = getTgUser();
    const tgUserId = tg?.id ? String(tg.id) : "";
    const phoneDigits = normalizePhone(phone);

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          token: API_TOKEN,
          action: "cancelOrder",
          orderId,
          reason: r,
          tgUserId,
          phone: phoneDigits,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (data?.error) throw new Error(data.error);

      setToast({ type: "success", text: "Заказ отменён." });
      setCancelOrderId(null);
      setCancelReason("");
      loadMyOrders();
    } catch (e: any) {
      setToast({ type: "error", text: e?.message || "Не удалось отменить заказ" });
    }
  }

  // load orders when tab opened
  useEffect(() => {
    if (tab !== "orders") return;
    loadMyOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div style={styles.page}>
      {toast && (
        <div
          style={{
            ...styles.toast,
            ...(toast.type === "error" ? styles.toastError : {}),
            ...(toast.type === "success" ? styles.toastSuccess : {}),
            ...(toast.type === "info" ? styles.toastInfo : {}),
          }}
        >
          <div style={{ fontWeight: 700 }}>{toast.text}</div>
          <button style={styles.toastClose} onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}

      {/* ✅ ZOOM MODAL */}
      {zoomSrc && (
        <div style={styles.zoomOverlay} onClick={() => setZoomSrc(null)}>
          <div style={styles.zoomBox} onClick={(e) => e.stopPropagation()}>
            <button style={styles.zoomClose} onClick={() => setZoomSrc(null)}>
              ×
            </button>
            <img src={zoomSrc} alt="Фото товара" style={styles.zoomImg} />
          </div>
        </div>
      )}

      {/* ✅ CANCEL MODAL */}
      {cancelOrderId && (
        <div style={styles.zoomOverlay} onClick={() => setCancelOrderId(null)}>
          <div style={styles.zoomBox} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>
              Причина отмены заказа
            </div>

            <textarea
              style={styles.textarea}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Например: ошибся адресом, не актуально, изменились планы…"
            />

            <button
              style={styles.primaryBtn}
              onClick={() => cancelOrderRequest(cancelOrderId, cancelReason)}
            >
              Подтвердить отмену
            </button>

            <button
              style={styles.secondaryBtn}
              onClick={() => {
                setCancelOrderId(null);
                setCancelReason("");
              }}
            >
              Закрыть
            </button>
          </div>
        </div>
      )}

      <div style={styles.container}>
        {/* ===== HEADER ===== */}
        <div style={styles.headerGrid}>
          <div style={styles.headerLeft}>
            <div style={styles.title}>Нашенское</div>

            <button
              style={{
                ...styles.navBtn,
                ...(tab === "catalog" ? styles.navBtnActive : {}),
              }}
              onClick={() => setTab("catalog")}
            >
              Товары
            </button>
          </div>

          <div style={styles.headerRight}>
            <button
              style={{
                ...styles.navBtn,
                ...(tab === "cart" || tab === "checkout"
                  ? styles.navBtnActive
                  : {}),
              }}
              onClick={() => setTab("cart")}
            >
              🛒 Корзина ({cartCount})
            </button>

            <button
              style={{
                ...styles.navBtn,
                ...(tab === "orders" ? styles.navBtnActive : {}),
              }}
              onClick={() => setTab("orders")}
            >
              📦 Мои заказы
            </button>
          </div>
        </div>

        {loading && <div style={styles.info}>Загрузка ассортимента…</div>}
        {!loading && loadingHint && (
          <div style={styles.infoMuted}>{loadingHint}</div>
        )}
        {error && (
          <div style={{ ...styles.info, color: styles.colors.danger }}>{error}</div>
        )}

        {!loading && !error && (
          <>
            {tab === "catalog" && (
              <>
                <div style={styles.chipsRow}>
                  {categories.map((c) => (
                    <button
                      key={c}
                      style={{
                        ...styles.chip,
                        ...(c === "Акции" ? styles.chipPromo : {}),
                        ...(activeCategory === c
                          ? c === "Акции"
                            ? styles.chipPromoActive
                            : styles.chipActive
                          : {}),
                      }}
                      onClick={() => setActiveCategory(c)}
                    >
                      {c === "Акции" ? "🔥 Акции" : c}
                    </button>
                  ))}
                </div>

                <div style={styles.list}>
                  {filteredProducts.map((p) => {
                    const q = qtyOf(p.id);

                    return (
                      <div key={p.id} style={styles.card}>
                        {p.image ? (
                          <img
                            src={p.image}
                            alt={p.name}
                            style={styles.cardImg}
                            loading="lazy"
                            decoding="async"
                            onClick={() => setZoomSrc(p.image || null)}
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display =
                                "none";
                            }}
                          />
                        ) : (
                          <div style={styles.cardImgPlaceholder}>Нет фото</div>
                        )}

                        <div style={styles.cardBody}>
                          <div style={styles.cardName} title={p.name}>
                            {p.name}
                          </div>

                          {p.description ? (
                            <div style={styles.cardDesc} title={p.description}>
                              {p.description}
                            </div>
                          ) : null}

                          <div style={styles.cardMeta}>
                            <span style={styles.price}>{money(p.price)} ₽</span>
                            <span style={styles.unit}> / {p.unit}</span>
                          </div>

                          {q === 0 ? (
                            <button style={styles.buyBtn} onClick={() => addToCart(p)}>
                              В корзину
                            </button>
                          ) : (
                            <div style={styles.qtyInline}>
                              <button
                                style={styles.qtyBtn}
                                onClick={() => setQty(p.id, q - 1)}
                              >
                                −
                              </button>
                              <div style={styles.qtyNum}>{q}</div>
                              <button
                                style={styles.qtyBtn}
                                onClick={() => setQty(p.id, q + 1)}
                              >
                                +
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* ✅ CART (2 columns layout) */}
            {tab === "cart" && (
              <div style={styles.panel}>
                {cartItems.length === 0 ? (
                  <div style={styles.info}>Корзина пустая</div>
                ) : (
                  <>
                    {cartItems.map((it) => (
                      <div key={it.product.id} style={styles.cartRow2}>
                        <div style={styles.cartLeft2}>
                          <div style={styles.cartName2} title={it.product.name}>
                            {it.product.name}
                          </div>
                          <div style={styles.cartMeta2}>
                            {money(it.product.price)} ₽ / {it.product.unit}
                          </div>
                        </div>

                        <div style={styles.cartRight2}>
                          <div style={styles.cartSum2}>
                            {money(it.qty * it.product.price)} ₽
                          </div>

                          <div style={styles.cartQty2}>
                            <button
                              style={styles.qtyBtn2}
                              onClick={() => setQty(it.product.id, it.qty - 1)}
                            >
                              −
                            </button>
                            <div style={styles.qtyNum2}>{it.qty}</div>
                            <button
                              style={styles.qtyBtn2}
                              onClick={() => setQty(it.product.id, it.qty + 1)}
                            >
                              +
                            </button>
                          </div>

                          <button
                            style={styles.removeBtn2}
                            onClick={() => setQty(it.product.id, 0)}
                            title="Удалить"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))}

                    <div style={styles.totalBlock}>
                      <div style={styles.totalRow}>
                        <div>Товары</div>
                        <div style={{ fontWeight: 700 }}>{money(total)} ₽</div>
                      </div>

                      <div style={styles.totalRow}>
                        <div>
                          Доставка{" "}
                          {delivery === 0 ? (
                            <span style={styles.freeTag}>бесплатно</span>
                          ) : (
                            <span style={styles.mutedTag}>
                              до {money(FREE_DELIVERY_FROM)} ₽
                            </span>
                          )}
                        </div>
                        <div style={{ fontWeight: 700 }}>{money(delivery)} ₽</div>
                      </div>

                      <div style={styles.totalRowBig}>
                        <div>Итого</div>
                        <div style={{ fontWeight: 800 }}>{money(grandTotal)} ₽</div>
                      </div>
                    </div>

                    <button style={styles.primaryBtn} onClick={() => setTab("checkout")}>
                      Оформить
                    </button>
                  </>
                )}
              </div>
            )}

            {tab === "checkout" && (
              <div style={styles.panel}>
                <div style={styles.h2}>Оформление</div>

                <label style={styles.label}>
                  Имя <span style={{ color: styles.colors.danger }}>*</span>
                </label>
                <input
                  style={styles.input}
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Как к вам обращаться?"
                  autoComplete="name"
                />

                <label style={styles.label}>
                  Телефон <span style={{ color: styles.colors.danger }}>*</span>
                </label>
                <input
                  style={styles.input}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+7..."
                  autoComplete="tel"
                  inputMode="tel"
                />

                <label style={styles.label}>
                  Адрес доставки <span style={{ color: styles.colors.danger }}>*</span>
                </label>
                <input
                  style={styles.input}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="улица, дом, подъезд, этаж, кв."
                  autoComplete="street-address"
                />

                <label style={styles.label}>Комментарий (необязательно)</label>
                <input
                  style={styles.input}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="код домофона, удобное время"
                />

                <div style={styles.totalBlock}>
                  <div style={styles.totalRow}>
                    <div>Товары</div>
                    <div style={{ fontWeight: 700 }}>{money(total)} ₽</div>
                  </div>

                  <div style={styles.totalRow}>
                    <div>
                      Доставка{" "}
                      {delivery === 0 ? (
                        <span style={styles.freeTag}>бесплатно</span>
                      ) : (
                        <span style={styles.mutedTag}>
                          до {money(FREE_DELIVERY_FROM)} ₽
                        </span>
                      )}
                    </div>
                    <div style={{ fontWeight: 700 }}>{money(delivery)} ₽</div>
                  </div>

                  <div style={styles.totalRowBig}>
                    <div>Итого</div>
                    <div style={{ fontWeight: 800 }}>{money(grandTotal)} ₽</div>
                  </div>
                </div>

                <button
                  style={{
                    ...styles.primaryBtn,
                    opacity: sending ? 0.75 : 1,
                    cursor: sending ? "not-allowed" : "pointer",
                  }}
                  onClick={submitOrder}
                  disabled={sending}
                >
                  {sending ? "Отправляем..." : "Подтвердить заказ"}
                </button>

                <button
                  style={styles.secondaryBtn}
                  onClick={() => setTab("cart")}
                  disabled={sending}
                >
                  Назад в корзину
                </button>

                <div style={styles.note}>
                  Оплата пока не принимается в приложении — мы свяжемся после оформления.
                </div>
              </div>
            )}

            {tab === "orders" && (
              <div style={styles.panel}>
                <div style={styles.ordersHeader}>
                  <div style={styles.h2}>Мои заказы</div>
                  <button
                    style={styles.refreshBtn}
                    onClick={loadMyOrders}
                    disabled={ordersLoading}
                    title="Обновить"
                  >
                    {ordersLoading ? "Обновляем…" : "↻"}
                  </button>
                </div>

                {ordersError ? (
                  <div style={{ ...styles.info, color: styles.colors.danger }}>
                    {ordersError}
                  </div>
                ) : null}

                {ordersLoading && !orders.length ? (
                  <div style={styles.info}>Загружаем заказы…</div>
                ) : null}

                {!ordersLoading && !ordersError && orders.length === 0 ? (
                  <div style={styles.infoMuted}>
                    Заказов пока нет. Оформи первый заказ — и он появится здесь.
                  </div>
                ) : null}

                <div style={styles.ordersList}>
                  {orders.map((o, idx) => (
                    <div key={o.orderId || idx} style={styles.orderCard}>
                      <div style={styles.orderTop}>
                        <div style={styles.orderDate}>{formatDate(o.createdAt)}</div>
                        <div style={styles.orderStatus}>{humanStatus(o.status)}</div>
                      </div>

                      <div style={styles.orderTotals}>
                        <div style={styles.orderRow}>
                          <div>Товары</div>
                          <div style={{ fontWeight: 700 }}>{money(o.total)} ₽</div>
                        </div>
                        <div style={styles.orderRow}>
                          <div>Доставка</div>
                          <div style={{ fontWeight: 700 }}>{money(o.delivery)} ₽</div>
                        </div>
                        <div style={styles.orderRowBig}>
                          <div>Итого</div>
                          <div style={{ fontWeight: 800 }}>{money(o.grandTotal)} ₽</div>
                        </div>
                      </div>

                      {o.status === "canceled" && o.cancelReason ? (
                        <div style={styles.cancelReason}>
                          Причина отмены: {o.cancelReason}
                        </div>
                      ) : null}

                      <div style={styles.orderItems}>
                        {Array.isArray(o.items) &&
                          o.items.slice(0, 20).map((it, j) => (
                            <div key={j} style={styles.orderItemRow}>
                              <div style={styles.orderItemName} title={it.name}>
                                {it.name}
                              </div>
                              <div style={styles.orderItemQty}>×{it.qty}</div>
                              <div style={styles.orderItemSum}>{money(it.sum)} ₽</div>
                            </div>
                          ))}
                        {Array.isArray(o.items) && o.items.length > 20 ? (
                          <div style={styles.infoMuted}>Показаны первые 20 позиций…</div>
                        ) : null}
                      </div>

                      {String(o.status || "").toLowerCase() === "new" && o.orderId ? (
                        <button
                          style={styles.cancelBtn}
                          onClick={() => {
                            setCancelOrderId(o.orderId);
                            setCancelReason("");
                          }}
                        >
                          Отменить заказ
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ✅ FLOATING CART: показываем сумму БЕЗ доставки */}
      {tab === "catalog" && cartCount > 0 && (
        <button style={styles.floatingCart} onClick={() => setTab("cart")}>
          🛒 {cartCount} • {money(total)} ₽
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> & {
  colors: {
    ink: string;
    primary: string;
    sun: string;
    orange: string;
    danger: string;
  };
} = {
  colors: {
    ink: "#264653",
    primary: "#2a9d8f",
    sun: "#e9c46a",
    orange: "#f4a261",
    danger: "#e76f51",
  },

  page: {
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    padding: 16,
    minHeight: "100vh",
    boxSizing: "border-box",
    color: "#264653",
    backgroundImage:
      "linear-gradient(rgba(255,255,255,0.30), rgba(255,255,255,0.50)), url('/images/bg-farm.png')",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center top",
    backgroundSize: "cover",
    backgroundAttachment: "fixed",
  },

  container: {
    maxWidth: 520,
    width: "100%",
    boxSizing: "border-box",
    margin: "0 auto",
    background: "rgba(255,255,255,0.60)",
    borderRadius: 22,
    padding: 12,
    boxShadow: "0 18px 34px rgba(38,70,83,0.18)",
    border: "1px solid rgba(38,70,83,0.10)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    overflow: "hidden",
  },

  toast: {
    position: "sticky",
    top: 8,
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "12px 12px",
    borderRadius: 14,
    boxShadow: "0 10px 22px rgba(38,70,83,0.16)",
    marginBottom: 10,
    border: "1px solid rgba(38,70,83,0.10)",
    background: "rgba(255,255,255,0.92)",
    color: "#264653",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    boxSizing: "border-box",
  },
  toastError: { background: "rgba(231,111,81,0.16)", color: "#264653" },
  toastSuccess: { background: "rgba(42,157,143,0.16)", color: "#264653" },
  toastInfo: { background: "rgba(233,196,106,0.20)", color: "#264653" },
  toastClose: {
    border: 0,
    background: "transparent",
    fontSize: 22,
    lineHeight: 1,
    cursor: "pointer",
    padding: 4,
    color: "#264653",
  },

  headerGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    alignItems: "start",
    marginBottom: 12,
  },
  headerLeft: { display: "grid", gap: 10, minWidth: 0 },
  headerRight: { display: "grid", gap: 10, minWidth: 0 },

  title: {
    fontSize: 26,
    fontWeight: 700,
    letterSpacing: -0.2,
    background: "linear-gradient(90deg, #1E2A32 0%, #e9c46a 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    height: 42,
    display: "flex",
    alignItems: "center",
    marginLeft: 9,
  },

  navBtn: {
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    border: "1px solid rgba(38,70,83,0.18)",
    background: "rgba(255,255,255,0.78)",
    padding: "10px 14px",
    borderRadius: 999,
    fontWeight: 650,
    cursor: "pointer",
    boxShadow: "0 6px 14px rgba(38,70,83,0.12)",
    color: "#264653",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    height: 42,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },

  navBtnActive: {
    borderColor: "rgba(42,157,143,0.35)",
    background:
      "linear-gradient(180deg, rgba(42,157,143,0.98) 0%, rgba(38,70,83,0.98) 140%)",
    color: "#ffffff",
    boxShadow: "0 10px 22px rgba(42,157,143,0.20)",
  },

  // ✅ chips in multiple rows (wrap)
  chipsRow: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    overflowX: "visible",
    paddingBottom: 10,
    marginBottom: 10,
  },

  chip: {
    border: "1px solid rgba(38,70,83,0.18)",
    background: "rgba(255,255,255,0.74)",
    padding: "9px 12px",
    borderRadius: 999,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxShadow: "0 6px 14px rgba(38,70,83,0.10)",
    color: "#264653",
    boxSizing: "border-box",
  },

  chipActive: {
    borderColor: "rgba(42,157,143,0.35)",
    background:
      "linear-gradient(180deg, rgba(42,157,143,0.98) 0%, rgba(38,70,83,0.98) 140%)",
    color: "#ffffff",
    boxShadow: "0 10px 22px rgba(42,157,143,0.18)",
  },

  // ✅ PROMO CHIP STYLES (в твоей палитре)
  chipPromo: {
    background: "rgba(244,162,97,0.20)",
    border: "1px solid rgba(244,162,97,0.65)",
    color: "#264653",
    fontWeight: 700,
  },

  chipPromoActive: {
    background:
      "linear-gradient(180deg, rgba(244,162,97,1) 0%, rgba(231,111,81,1) 140%)",
    color: "#ffffff",
    borderColor: "rgba(244,162,97,0.35)",
    boxShadow: "0 10px 22px rgba(244,162,97,0.25)",
  },

  info: { padding: 12, fontWeight: 650, color: "#264653" },
  infoMuted: { padding: 8, color: "rgba(38,70,83,0.82)", fontWeight: 550 },

  list: { display: "grid", gap: 12 },

  card: {
    background: "rgba(255,255,255,0.55)",
    borderRadius: 18,
    overflow: "hidden",
    boxShadow: "0 10px 22px rgba(38,70,83,0.14)",
    border: "1px solid rgba(38,70,83,0.10)",
    display: "grid",
    gridTemplateColumns: "110px 1fr",
    alignItems: "start",
    boxSizing: "border-box",
  },

  cardImg: {
    width: 110,
    height: 108,
    objectFit: "cover",
    display: "block",
    alignSelf: "start",
    cursor: "zoom-in",
  },

  cardImgPlaceholder: {
    width: 110,
    height: 108,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(233,196,106,0.22)",
    color: "#264653",
    fontWeight: 650,
    boxSizing: "border-box",
    alignSelf: "start",
  },

  cardBody: {
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    boxSizing: "border-box",
  },

  cardName: {
    fontSize: 16,
    fontWeight: 650,
    lineHeight: 1.15,
    color: "#264653",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },

  cardDesc: {
    fontSize: 12,
    color: "rgba(38,70,83,0.80)",
    lineHeight: 1.25,
    fontWeight: 450,
    display: "-webkit-box",
    WebkitLineClamp: 5,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },

  cardMeta: { fontWeight: 550 },

  price: { color: "#2a9d8f", fontWeight: 700 },
  unit: { color: "rgba(38,70,83,0.85)", fontWeight: 500 },

  buyBtn: {
    marginTop: 4,
    background:
      "linear-gradient(180deg, rgba(42,157,143,1) 0%, rgba(38,70,83,1) 140%)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.22)",
    borderRadius: 14,
    padding: "9px 12px",
    fontWeight: 650,
    cursor: "pointer",
    width: "fit-content",
    boxShadow: "0 10px 22px rgba(42,157,143,0.18)",
    boxSizing: "border-box",
  },

  qtyInline: { display: "flex", alignItems: "center", gap: 8, marginTop: 4 },

  qtyBtn: {
    width: 34,
    height: 34,
    borderRadius: 12,
    border: "1px solid rgba(38,70,83,0.16)",
    background: "rgba(255,255,255,0.82)",
    fontSize: 18,
    cursor: "pointer",
    boxShadow: "0 8px 16px rgba(38,70,83,0.10)",
    color: "#264653",
    boxSizing: "border-box",
  },

  qtyNum: {
    minWidth: 24,
    textAlign: "center",
    fontWeight: 650,
    color: "#264653",
  },

  panel: {
    background: "rgba(255,255,255,0.80)",
    borderRadius: 18,
    padding: 12,
    boxShadow: "0 10px 22px rgba(38,70,83,0.14)",
    border: "1px solid rgba(38,70,83,0.10)",
    boxSizing: "border-box",
  },

  totalBlock: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: "1px solid rgba(38,70,83,0.10)",
    display: "grid",
    gap: 8,
  },

  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 14,
    color: "#264653",
    fontWeight: 550,
  },

  totalRowBig: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 16,
    paddingTop: 6,
    marginTop: 4,
    borderTop: "1px dashed rgba(38,70,83,0.22)",
    color: "#264653",
  },

  freeTag: {
    marginLeft: 8,
    padding: "3px 8px",
    borderRadius: 999,
    background: "rgba(233,196,106,0.30)",
    color: "#264653",
    fontWeight: 650,
    fontSize: 12,
    border: "1px solid rgba(233,196,106,0.65)",
    boxSizing: "border-box",
  },

  mutedTag: {
    marginLeft: 8,
    padding: "3px 8px",
    borderRadius: 999,
    background: "rgba(244,162,97,0.18)",
    color: "#264653",
    fontWeight: 600,
    fontSize: 12,
    border: "1px solid rgba(244,162,97,0.55)",
    boxSizing: "border-box",
  },

  h2: { fontSize: 18, fontWeight: 650, marginBottom: 10, color: "#264653" },

  label: {
    display: "block",
    marginTop: 10,
    fontWeight: 600,
    fontSize: 14,
    color: "#264653",
  },

  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 12px",
    borderRadius: 14,
    border: "1px solid rgba(38,70,83,0.16)",
    marginTop: 6,
    fontSize: 14,
    background: "rgba(255,255,255,0.86)",
    outline: "none",
    boxShadow: "0 8px 14px rgba(38,70,83,0.08)",
    color: "#264653",
  },

  textarea: {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 12px",
    borderRadius: 14,
    border: "1px solid rgba(38,70,83,0.16)",
    marginTop: 6,
    fontSize: 14,
    background: "rgba(255,255,255,0.86)",
    outline: "none",
    boxShadow: "0 8px 14px rgba(38,70,83,0.08)",
    color: "#264653",
    minHeight: 90,
    resize: "vertical",
  },

  primaryBtn: {
    width: "100%",
    marginTop: 12,
    background:
      "linear-gradient(180deg, rgba(42,157,143,1) 0%, rgba(38,70,83,1) 140%)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.22)",
    borderRadius: 16,
    padding: "13px 14px",
    fontWeight: 650,
    cursor: "pointer",
    boxShadow: "0 12px 26px rgba(42,157,143,0.18)",
    boxSizing: "border-box",
  },

  secondaryBtn: {
    width: "100%",
    marginTop: 10,
    background: "rgba(244,162,97,0.18)",
    color: "#264653",
    border: "1px solid rgba(244,162,97,0.55)",
    borderRadius: 16,
    padding: "13px 14px",
    fontWeight: 650,
    cursor: "pointer",
    boxShadow: "0 10px 22px rgba(244,162,97,0.14)",
    boxSizing: "border-box",
  },

  note: {
    marginTop: 10,
    fontSize: 12,
    color: "rgba(38,70,83,0.80)",
    fontWeight: 450,
  },

  floatingCart: {
    position: "fixed",
    left: "50%",
    transform: "translateX(-50%)",
    bottom: 16,
    zIndex: 9999,
    maxWidth: 520,
    width: "calc(100% - 32px)",
    boxSizing: "border-box",
    border: "1px solid rgba(38,70,83,0.16)",
    background:
      "linear-gradient(180deg, rgba(233,196,106,0.92) 0%, rgba(244,162,97,0.90) 100%)",
    color: "#264653",
    borderRadius: 999,
    padding: "12px 14px",
    fontWeight: 650,
    cursor: "pointer",
    boxShadow: "0 16px 32px rgba(38,70,83,0.18)",
  },

  // orders UI
  ordersHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 6,
  },

  refreshBtn: {
    border: "1px solid rgba(38,70,83,0.16)",
    background: "rgba(255,255,255,0.85)",
    borderRadius: 12,
    padding: "8px 10px",
    cursor: "pointer",
    fontWeight: 700,
    boxShadow: "0 8px 14px rgba(38,70,83,0.08)",
  },

  ordersList: { display: "grid", gap: 10, marginTop: 10 },

  orderCard: {
    background: "rgba(255,255,255,0.70)",
    border: "1px solid rgba(38,70,83,0.10)",
    borderRadius: 16,
    padding: 12,
    boxShadow: "0 10px 18px rgba(38,70,83,0.10)",
  },

  orderTop: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 8,
  },

  orderDate: { fontWeight: 650, color: "#264653" },
  orderStatus: { fontWeight: 650, color: "rgba(38,70,83,0.85)" },

  orderTotals: {
    display: "grid",
    gap: 6,
    paddingBottom: 8,
    borderBottom: "1px solid rgba(38,70,83,0.10)",
    marginBottom: 8,
  },

  orderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: 14,
    color: "#264653",
  },

  orderRowBig: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: 15,
    color: "#264653",
    paddingTop: 6,
    marginTop: 2,
    borderTop: "1px dashed rgba(38,70,83,0.20)",
  },

  orderItems: { display: "grid", gap: 6 },

  orderItemRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto auto",
    gap: 8,
    alignItems: "baseline",
  },

  orderItemName: {
    fontSize: 13,
    color: "rgba(38,70,83,0.90)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  orderItemQty: {
    fontSize: 13,
    color: "rgba(38,70,83,0.75)",
    fontWeight: 600,
  },

  orderItemSum: { fontSize: 13, color: "#264653", fontWeight: 650 },

  cancelBtn: {
    width: "100%",
    marginTop: 10,
    border: "1px solid rgba(231,111,81,0.55)",
    background: "rgba(231,111,81,0.14)",
    color: "#264653",
    borderRadius: 14,
    padding: "11px 12px",
    fontWeight: 750,
    cursor: "pointer",
    boxShadow: "0 8px 14px rgba(231,111,81,0.12)",
    boxSizing: "border-box",
  },

  cancelReason: {
    marginTop: 8,
    fontSize: 13,
    color: "rgba(38,70,83,0.88)",
    background: "rgba(244,162,97,0.16)",
    border: "1px solid rgba(244,162,97,0.40)",
    borderRadius: 12,
    padding: "8px 10px",
  },

  // CART 2-column
  cartRow2: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 132px",
    gap: 10,
    alignItems: "start",
    padding: "12px 0",
    borderBottom: "1px solid rgba(38,70,83,0.10)",
  },

  cartLeft2: { minWidth: 0, display: "grid", gap: 4 },

  cartName2: {
    fontWeight: 750,
    fontSize: 15,
    color: "#264653",
    lineHeight: 1.18,
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },

  cartMeta2: {
    color: "rgba(38,70,83,0.75)",
    fontWeight: 550,
    fontSize: 12,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },

  cartRight2: { display: "grid", justifyItems: "end", gap: 8 },

  cartSum2: { fontWeight: 800, color: "#264653", whiteSpace: "nowrap" },

  cartQty2: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 6px",
    borderRadius: 14,
    border: "1px solid rgba(38,70,83,0.12)",
    background: "rgba(255,255,255,0.70)",
    boxShadow: "0 8px 14px rgba(38,70,83,0.08)",
  },

  qtyBtn2: {
    width: 28,
    height: 28,
    borderRadius: 10,
    border: "1px solid rgba(38,70,83,0.14)",
    background: "rgba(255,255,255,0.92)",
    fontSize: 18,
    cursor: "pointer",
    color: "#264653",
    lineHeight: 1,
  },

  qtyNum2: {
    minWidth: 18,
    textAlign: "center",
    fontWeight: 800,
    color: "#264653",
  },

  removeBtn2: {
    width: 34,
    height: 34,
    borderRadius: 12,
    border: "1px solid rgba(231,111,81,0.55)",
    background: "rgba(231,111,81,0.14)",
    color: "#264653",
    fontSize: 20,
    cursor: "pointer",
    lineHeight: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 8px 14px rgba(231,111,81,0.12)",
  },

  // ZOOM MODAL
  zoomOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 10000,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },

  zoomBox: {
    position: "relative",
    width: "min(520px, 100%)",
    maxHeight: "85vh",
    background: "rgba(255,255,255,0.92)",
    borderRadius: 18,
    padding: 10,
    boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
    overflow: "hidden",
  },

  zoomImg: {
    width: "100%",
    height: "auto",
    maxHeight: "80vh",
    objectFit: "contain",
    borderRadius: 14,
    display: "block",
  },

  zoomClose: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 36,
    height: 36,
    borderRadius: 12,
    border: "1px solid rgba(38,70,83,0.16)",
    background: "rgba(255,255,255,0.85)",
    cursor: "pointer",
    fontSize: 22,
    lineHeight: 1,
    color: "#264653",
    boxShadow: "0 8px 14px rgba(0,0,0,0.12)",
  },
};
