"""Stock quantities use integer tenths in SQLite and numeric units in the API."""
import math
from decimal import Decimal, InvalidOperation
from typing import Annotated

from pydantic import BeforeValidator, PlainSerializer
from sqlalchemy import Integer
from sqlalchemy.types import TypeDecorator

MAX_QUANTITY = 1_000_000_000


def validate_quantity(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("数量必须是最多一位小数的数字")
    try:
        number = Decimal(str(value))
        if not number.is_finite() or abs(number) > MAX_QUANTITY:
            raise ValueError("数量超出范围")
        if number * 10 != (number * 10).to_integral_value():
            raise ValueError("数量最多保留一位小数")
    except InvalidOperation as exc:
        raise ValueError("数量必须是数字") from exc
    return float(number)


def display_number(value):
    value = round(float(value), 1)
    return int(value) if value.is_integer() else value


Quantity = Annotated[float, PlainSerializer(display_number, return_type=int | float)]
QuantityInput = Annotated[Quantity, BeforeValidator(validate_quantity)]


def ticks(value):
    number = float(value) * 10
    if not math.isfinite(number) or not math.isclose(number, round(number), rel_tol=0, abs_tol=0.00001):
        raise ValueError("数量最多保留一位小数")
    return round(number)


class QuantityColumn(TypeDecorator):
    """Bind/result conversion also applies to SQL arithmetic and sum()."""
    impl = Integer
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return None if value is None else ticks(value)

    def process_result_value(self, value, dialect):
        return None if value is None else value / 10
