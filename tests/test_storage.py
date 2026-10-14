import pytest

from laurence_lab_bot.storage import Storage


@pytest.fixture
def db(tmp_path):
    s = Storage(str(tmp_path / "test.db"))
    yield s
    s.close()


def _order(db, **kw):
    base = dict(
        user_id=1, chat_id=1, customer_name="Ada", phone="0800", items=[{"id": "jollof", "name": "Jollof Rice", "price": 1500, "qty": 2}],
        subtotal=3000, delivery_fee=500, total=3500, fulfilment="delivery", address="Lekki", payment_method="cod",
    )
    base.update(kw)
    return db.create_order(**base)


def test_create_and_fetch(db):
    o = _order(db)
    assert o.id.startswith("LL-") and len(o.id) == 9
    assert db.get_order(o.id.lower()).total == 3500
    assert o.status == "received"


def test_status_and_payment_updates(db):
    o = _order(db)
    assert db.set_status(o.id, "preparing").status == "preparing"
    assert db.update_order(o.id, payment_status="paid").payment_status == "paid"
    with pytest.raises(ValueError):
        db.set_status(o.id, "bogus")


def test_user_queries_and_stats(db):
    _order(db, user_id=7)
    _order(db, user_id=7, status="delivered")
    _order(db, user_id=8)
    assert len(db.orders_for_user(7)) == 2
    assert len(db.active_orders()) == 2
    s = db.stats()
    assert s["orders"] == 3 and s["revenue"] == 10500


def test_customers_inquiries_tickets(db):
    db.remember_customer(5, name="Ada", phone="0801")
    db.remember_customer(5, last_address="VI")
    c = db.get_customer(5)
    assert c["phone"] == "0801" and c["last_address"] == "VI"
    assert db.create_inquiry(5, 5, "Ada", "Acme", "0801", "Catering for 50") == 1
    assert db.list_inquiries()[0]["company"] == "Acme"
    db.create_ticket(5, 5, "ada", "Where is my food?")
    assert db.stats()["open_tickets"] == 1
    db.close_tickets_for_user(5)
    assert db.stats()["open_tickets"] == 0
