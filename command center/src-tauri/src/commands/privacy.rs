//! PII & content privacy diffuser.
//!
//! Before a prompt leaves this machine for a cloud model, the droplet, or an
//! external verifier/overseer, sensitive spans are swapped for stable local
//! tokens (`[EMAIL_1]`, `[PHONE_1]`, `[AMOUNT_1]`, `[CLIENT_1]`…). The mapping
//! never leaves the process; replies are re-hydrated locally.
//!
//! Honest limits: this is pattern matching. It reliably catches emails, phone
//! numbers, money, keys/tokens, street addresses and postal codes, plus every
//! name/term the user lists in Settings. It cannot recognise an arbitrary
//! person's name it has never been told about — list your clients there.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Replacement {
    pub token: String,
    pub kind: String,
    pub original: String,
}

#[derive(Default)]
pub struct Redactor {
    pub replacements: Vec<Replacement>,
}

struct Pattern {
    kind: &'static str,
    re: Regex,
}

fn patterns() -> &'static [Pattern] {
    static P: OnceLock<Vec<Pattern>> = OnceLock::new();
    P.get_or_init(|| {
        let mk = |kind, re: &str| Pattern { kind, re: Regex::new(re).expect("privacy regex") };
        vec![
            // Keys and tokens first so their digits aren't eaten by other patterns.
            mk("KEY", r"\b(?:sk-[A-Za-z0-9_\-]{16,}|sk-ant-[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})"),
            mk("EMAIL", r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
            mk("CARD", r"\b(?:\d[ \-]?){13,19}\b"),
            mk("PHONE", r"(?:\+?1[\s.\-]?)?\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b"),
            mk("AMOUNT", r"(?i)(?:[$€£]\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?[kKmM]\b)?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|bucks|cad|usd|eur|gbp)\b)"),
            mk("ADDRESS", r"(?i)\b\d{1,6}\s+(?:[A-Za-z0-9'\.]+\s){1,4}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|cres|crescent|lane|ln|way|court|ct|place|pl|trail|trl|parkway|pkwy|terrace|ter|circle|cir|square|sq|hwy|highway)\b\.?(?:,?\s*(?:unit|apt|suite|#)\s*[A-Za-z0-9\-]+)?"),
            mk("POSTAL", r"\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ \-]?\d[ABCEGHJ-NPRSTV-Z]\d\b|\b\d{5}(?:-\d{4})\b"),
        ]
    })
}

impl Redactor {
    fn token_for(&mut self, kind: &str, original: &str) -> String {
        if let Some(r) = self.replacements.iter().find(|r| r.original == original) {
            return r.token.clone();
        }
        let n = self.replacements.iter().filter(|r| r.kind == kind).count() + 1;
        let token = format!("[{kind}_{n}]");
        self.replacements.push(Replacement { token: token.clone(), kind: kind.into(), original: original.into() });
        token
    }

    /// Redact one string. Call repeatedly with the same redactor so the same
    /// value maps to the same token across a whole conversation.
    pub fn redact(&mut self, text: &str, terms: &[String]) -> String {
        let mut out = text.to_string();
        // User-listed names/terms (clients, venues, project names), longest first.
        let mut terms: Vec<&String> = terms.iter().filter(|t| t.trim().len() >= 2).collect();
        terms.sort_by_key(|t| std::cmp::Reverse(t.len()));
        for term in terms {
            let Ok(re) = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(term.trim()))) else { continue };
            let found: Vec<String> = re.find_iter(&out).map(|m| m.as_str().to_string()).collect();
            for f in found {
                let tok = self.token_for("CLIENT", &f);
                out = out.replace(&f, &tok);
            }
        }
        for p in patterns() {
            let found: Vec<String> = p.re.find_iter(&out).map(|m| m.as_str().to_string()).filter(|s| !s.starts_with('[')).collect();
            for f in found {
                // Don't treat plain years / tiny numbers as phones or cards.
                if (p.kind == "PHONE" || p.kind == "CARD") && f.chars().filter(|c| c.is_ascii_digit()).count() < 10 {
                    continue;
                }
                let tok = self.token_for(p.kind, &f);
                out = out.replace(&f, &tok);
            }
        }
        out
    }

    /// Put the real values back into a reply (local only).
    pub fn rehydrate(&self, text: &str) -> String {
        let mut out = text.to_string();
        let mut reps: Vec<&Replacement> = self.replacements.iter().collect();
        reps.sort_by_key(|r| std::cmp::Reverse(r.token.len()));
        for r in reps {
            out = out.replace(&r.token, &r.original);
            // Models sometimes drop the brackets.
            let bare = r.token.trim_matches(|c| c == '[' || c == ']');
            out = out.replace(bare, &r.original);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_and_rehydrates() {
        let mut r = Redactor::default();
        let s = "Email sam@acme.com or call 416-555-0199 about the $1,250.00 deposit at 22 Queen Street West, M5H 2N2 for Maria Lopez.";
        let red = r.redact(s, &["Maria Lopez".into()]);
        assert!(!red.contains("sam@acme.com"), "{red}");
        assert!(!red.contains("416-555-0199"), "{red}");
        assert!(!red.contains("1,250"), "{red}");
        assert!(!red.contains("Maria"), "{red}");
        assert!(!red.contains("M5H"), "{red}");
        assert!(red.contains("[EMAIL_1]") && red.contains("[CLIENT_1]"), "{red}");
        assert_eq!(r.rehydrate(&red), s);
    }

    #[test]
    fn same_value_same_token() {
        let mut r = Redactor::default();
        let a = r.redact("a@b.co and a@b.co", &[]);
        assert_eq!(a, "[EMAIL_1] and [EMAIL_1]");
    }

    #[test]
    fn leaves_years_alone() {
        let mut r = Redactor::default();
        assert_eq!(r.redact("Born 1994, 32 years", &[]), "Born 1994, 32 years");
    }
}
