//! Integer tenths in storage/arithmetic, numeric inventory units on the wire.
use rusqlite::types::{FromSql, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    cmp::Ordering,
    iter::Sum,
    ops::{Add, Neg, Sub, SubAssign},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Quantity(pub i64);

impl Serialize for Quantity {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.0 % 10 == 0 {
            serializer.serialize_i64(self.0 / 10)
        } else {
            serializer.serialize_f64(self.0 as f64 / 10.0)
        }
    }
}
impl<'de> Deserialize<'de> for Quantity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let value = value
            .as_f64()
            .ok_or_else(|| serde::de::Error::custom("数量必须是数字"))?;
        let scaled = value * 10.0;
        if !value.is_finite()
            || value < 0.0
            || value.abs() > 1_000_000_000.0
            || (scaled - scaled.round()).abs() > 0.000001
        {
            return Err(serde::de::Error::custom(
                "数量最多保留一位小数且不能超过十亿",
            ));
        }
        Ok(Self(scaled.round() as i64))
    }
}
impl FromSql for Quantity {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        Ok(Self(value.as_i64()?))
    }
}
impl ToSql for Quantity {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.0.into())
    }
}
impl Add for Quantity {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self(self.0 + rhs.0)
    }
}
impl Sub for Quantity {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self(self.0 - rhs.0)
    }
}
impl SubAssign for Quantity {
    fn sub_assign(&mut self, rhs: Self) {
        self.0 -= rhs.0;
    }
}
impl Neg for Quantity {
    type Output = Self;
    fn neg(self) -> Self {
        Self(-self.0)
    }
}
impl Sum for Quantity {
    fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
        Self(iter.map(|q| q.0).sum())
    }
}
// Integer constants in business rules are expressed in inventory units.
impl PartialEq<i64> for Quantity {
    fn eq(&self, other: &i64) -> bool {
        self.0 == other * 10
    }
}
impl PartialOrd<i64> for Quantity {
    fn partial_cmp(&self, other: &i64) -> Option<Ordering> {
        self.0.partial_cmp(&(other * 10))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tenths_are_exact_and_json_preserves_integer_display() {
        let mut q: Quantity = serde_json::from_str("1").unwrap();
        for _ in 0..10 {
            q -= serde_json::from_str("0.1").unwrap();
        }
        assert_eq!(q, 0);
        assert_eq!(serde_json::to_string(&q).unwrap(), "0");
        assert_eq!(serde_json::to_string(&Quantity(12)).unwrap(), "1.2");
        for raw in ["0.11", "true", "1000000000.1", "\"0.1\""] {
            assert!(serde_json::from_str::<Quantity>(raw).is_err());
        }
    }
}
