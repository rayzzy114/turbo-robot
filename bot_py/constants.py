from __future__ import annotations

from typing import Final

GAMES: Final = {
    "RAILROAD": {
        "ID": "game_railroad",
        "GAME_KEY": "railroad",
        "THEME": "chicken_farm",
        "ASSET_KEY": "railroad_preview",
        "TITLE": "Chicken Railroad",
    },
    "PLINKO": {
        "ID": "game_plinko_classic",
        "GAME_KEY": "plinko",
        "THEME": "plinko_classic",
        "TITLE": "Classic Plinko",
    },
    "OLYMPUS": {
        "ID": "game_olympus",
        "GAME_KEY": "olympus",
        "THEME": "gate_of_olympus",
        "TITLE": "Gates of Olympus",
    },
    "DRAG": {
        "ID": "game_drag",
        "GAME_KEY": "matching",
        "THEME": "money_drag",
        "TITLE": "Money Matching",
    },
    "MATCH3": {
        "ID": "game_match3",
        "GAME_KEY": "match3",
        "THEME": "3_v_ryad",
        "TITLE": "3 v ryad",
    },
}

CATEGORIES: Final = {
    "CHICKEN": "cat_chicken",
    "PLINKO": "cat_plinko",
    "SLOTS": "cat_slots",
    "MATCHING": "cat_matching",
}

GEOS: Final = [
    {"id": "en_usd", "name": "🇺🇸 Global", "lang": "en", "currency": "$", "label": "EN | USD"},
    {"id": "pt_brl", "name": "🇧🇷 Brazil", "lang": "pt", "currency": "R$", "label": "PT | BRL"},
    {"id": "es_eur", "name": "🇪🇸 Spain/Latam", "lang": "es", "currency": "€", "label": "ES | EUR"},
]

ASSETS: Final = {
    "WELCOME": "welcome_img",
    "PROFILE": "profile_img",
}


class Callback:
    MAIN_MENU = "main_menu"
    ORDER = "order"
    PROFILE = "profile"
    REF_SYSTEM = "ref_system"
    LANGUAGE_MENU = "language_menu"
    DELETE_THIS = "delete_this"
    SKIP_STARTING_BALANCE = "skip_starting_balance"
    GEN_PREVIEW = "gen_preview"
    TOP_UP_BALANCE = "top_up_balance"
    I_PAID = "i_paid"
    GEO_CUSTOM = "geo_custom"

    # Language
    SET_LANG_RU = "set_lang_ru"
    SET_LANG_EN = "set_lang_en"
    START_LANG_RU = "start_lang_ru"
    START_LANG_EN = "start_lang_en"

    # Prefixes
    BUY_CHECK_PREFIX = "buy_check_"
    GEO_PREFIX = "geo_"
    PAYMENT_CANCEL_PREFIX = "payment_cancel_"
    MANUAL_PAY_MENU_PREFIX = "manual_pay_menu_"
    MANUAL_PAY_PREFIX = "manual_pay_"
    MANUAL_PAID_PREFIX = "manual_paid_"
    CRYPTO_CHECK_PREFIX = "crypto_check_"
    PAY_PREFIX = "pay_"
    ADMIN_MANUAL_PREFIX = "admin_manual_"


class PaymentType:
    SINGLE = "single"
    SUB = "sub"
