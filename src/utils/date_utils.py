from datetime import date


def get_mtd_dates():
    today = date.today()
    start = today.replace(day=1)
    return start, today


def fmt(d: date) -> str:
    return d.strftime("%Y-%m-%d")
