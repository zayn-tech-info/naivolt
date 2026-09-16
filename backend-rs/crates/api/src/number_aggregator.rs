//! Pick which supplier SKU to buy from, across every enabled supplier.
//!
//! The old order was `provider_cost ASC` — cheapest first. On 5SIM the cheap
//! operators hand over a number and then never deliver an SMS, so every buy
//! burned through dead stock before reaching an operator that works. That is
//! why only the expensive picks appeared healthy.
//!
//! Ranking now leads with what a SKU actually delivered. Cost is the tiebreak,
//! so margin still matters between two sources that both work.

use rust_decimal::Decimal;

/// How much unproven stock is trusted, measured in orders.
///
/// A brand-new SKU is scored purely on the supplier's published rate. Each real
/// order drags the score toward what we observed, and after `PRIOR_WEIGHT`
/// orders the evidence outweighs the claim. Five is deliberately small: a SKU
/// that fails its first handful of buys should fall behind immediately, because
/// every probe of a dead operator costs a customer a real wait.
pub const PRIOR_WEIGHT: i64 = 5;

/// Only recent orders count. An operator that died last month should not coast
/// on a good history, and one that was fixed should be able to climb back.
pub const WINDOW_DAYS: i64 = 30;

/// Blend the supplier's published rate with what we observed.
///
/// Returns a fraction in `[0, 1]`. With no orders this is the published rate;
/// with many it converges on `delivered / attempts`.
/// Unused outside tests on purpose: production ranks in SQL via [`SCORE_SQL`],
/// and this is the specification that `sql_score_matches_rust_score` holds it to.
#[cfg_attr(not(test), allow(dead_code))]
pub fn score(published_rate_percent: Decimal, attempts: i64, delivered: i64) -> Decimal {
    let prior_weight = Decimal::from(PRIOR_WEIGHT);
    let prior = (published_rate_percent / Decimal::from(100)).clamp(Decimal::ZERO, Decimal::ONE);
    let attempts = Decimal::from(attempts.max(0));
    let delivered = Decimal::from(delivered.max(0));
    (delivered + prior_weight * prior) / (attempts + prior_weight)
}

/// [`score`], written in SQL. `$3` is the prior weight.
///
/// The ranking query is assembled from this exact string, and
/// `sql_score_matches_rust_score` evaluates it in Postgres against [`score`],
/// so the two definitions cannot drift apart.
pub const SCORE_SQL: &str = "(COALESCE(r.delivered, 0) + $3::numeric * (r.published / 100.0))
              / (COALESCE(r.attempts, 0) + $3::numeric)";

/// The ranking used to choose a source.
///
/// `$1` offer id, `$2` enabled providers, `$3` prior weight, `$4` window days.
pub fn ranked_sources_sql() -> String {
    format!(
        "SELECT r.provider, r.provider_country, r.provider_product, r.provider_operator
           FROM (
             SELECT s.provider, s.provider_country, s.provider_product,
                    s.provider_operator, s.provider_cost, s.stock,
                    s.provider_success_rate AS published,
                    counts.attempts, counts.delivered
               FROM number_offer_sources s
               LEFT JOIN LATERAL (
                     SELECT count(*) FILTER (WHERE o.phone_number IS NOT NULL) AS attempts,
                            count(*) FILTER (WHERE o.received_at IS NOT NULL)  AS delivered
                       FROM number_orders o
                      WHERE o.provider        = s.provider
                        AND o.source_product  = s.provider_product
                        AND o.source_country  = s.provider_country
                        AND o.source_operator = s.provider_operator
                        AND o.phone_number IS NOT NULL
                        AND o.created_at > now() - make_interval(days => $4::int)
               ) counts ON true
              WHERE s.offer_id = $1
                AND s.stock > 0
                AND s.provider_success_rate > 0
                AND s.provider = ANY($2::text[])
           ) r
          ORDER BY {SCORE_SQL} DESC,
                   r.provider_cost ASC,
                   r.stock DESC"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn an_unproven_sku_is_scored_on_the_published_rate() {
        assert_eq!(score(dec!(80), 0, 0), dec!(0.8));
        assert_eq!(score(dec!(0.93), 0, 0), dec!(0.0093));
    }

    #[test]
    fn observed_failures_sink_a_cheap_sku_below_an_honest_one() {
        // The shape of the 5SIM complaint: a cheap operator advertising 90%
        // that never delivers, against a dearer one advertising 70% that does.
        let cheap_liar = score(dec!(90), 20, 0);
        let dearer_honest = score(dec!(70), 20, 15);
        assert!(
            cheap_liar < dearer_honest,
            "cheap {cheap_liar} should rank below dear {dearer_honest}"
        );
    }

    #[test]
    fn one_bad_order_does_not_condemn_a_sku_but_a_run_of_them_does() {
        let published = dec!(80);
        let fresh = score(published, 0, 0);
        let one_miss = score(published, 1, 0);
        let five_misses = score(published, 5, 0);
        assert!(one_miss < fresh);
        assert!(five_misses < one_miss);
        // Still above zero: the published rate keeps a little pull.
        assert!(five_misses > Decimal::ZERO);
        // PRIOR_WEIGHT misses halve the claim exactly — that is what the prior
        // weight *means*, so pin it rather than assert something vaguer.
        assert_eq!(five_misses, published / dec!(200));
        assert_eq!(PRIOR_WEIGHT, 5, "this expectation is tied to the weight");
    }

    #[test]
    fn a_proven_sku_outranks_its_own_published_rate() {
        // Published 40% but delivers every time — evidence should win.
        let proven = score(dec!(40), 40, 40);
        assert!(proven > dec!(0.85), "{proven}");
    }

    /// The ranking runs in Postgres but the reasoning above is in Rust. Feed
    /// the *same* expression the query uses real numbers and require it to
    /// agree with [`score`], so an edit to one without the other is caught.
    #[tokio::test]
    async fn sql_score_matches_rust_score() {
        let database = crate::test_database::IsolatedDatabase::new("aggregator_score").await;
        let cases: [(Decimal, i64, i64); 6] = [
            (dec!(80), 0, 0),
            (dec!(0.93), 0, 0),
            (dec!(90), 20, 0),
            (dec!(70), 20, 15),
            (dec!(40), 40, 40),
            (dec!(50), 3, 1),
        ];
        let sql = format!(
            "SELECT {SCORE_SQL} FROM (SELECT $1::numeric AS published,
                                             $2::bigint  AS attempts,
                                             $4::bigint  AS delivered) r"
        );
        for (published, attempts, delivered) in cases {
            let from_sql: Decimal = sqlx::query_scalar(&sql)
                .bind(published)
                .bind(attempts)
                .bind(Decimal::from(PRIOR_WEIGHT))
                .bind(delivered)
                .fetch_one(&database.pool)
                .await
                .unwrap();
            let from_rust = score(published, attempts, delivered);
            assert_eq!(
                from_sql.round_dp(10),
                from_rust.round_dp(10),
                "published={published} attempts={attempts} delivered={delivered}"
            );
        }
        database.cleanup().await;
    }

    #[test]
    fn nonsense_counters_cannot_produce_a_negative_or_absurd_score() {
        assert!(score(dec!(150), 0, 0) <= Decimal::ONE);
        assert!(score(dec!(-10), 0, 0) >= Decimal::ZERO);
        assert!(score(dec!(80), -3, -3) >= Decimal::ZERO);
    }
}
