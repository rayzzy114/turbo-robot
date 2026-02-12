from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from html import escape
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from aiogram import BaseMiddleware, Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.filters.command import CommandObject
from aiogram.types import (
    CallbackQuery,
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
)

from .builder_bridge import cleanup_temp, generate_playable
from .config import CONFIG
from .constants import ASSETS, CATEGORIES, GAMES, GEOS
from .crypto_pay import CreateInvoiceParams, create_crypto_pay_invoice, get_crypto_pay_invoice, is_crypto_pay_enabled
from .db import DB, DBError
from .helpers import (
    DEFAULT_CURRENCY,
    DEFAULT_STARTING_BALANCE,
    build_order_summary,
    build_profile_message,
    calc_price,
    get_discount,
    get_library_path,
    parse_pay_callback,
)
from .session_store import FileSessionStore

SESSIONS_DIR = Path.cwd() / "sessions"
BOT_ASSETS_DIR = Path.cwd() / "assets"
ORDER_WIZARD_TIMEOUT_MS = 2 * 60 * 1000
FINAL_DELIVERY_DELAY_SECONDS = 30
MAX_CUSTOM_GEO_DESCRIPTION = 400
MAX_CTA_URL_LENGTH = 500
ORDER_STATUS_CANCELLED = "cancelled"
CANCELLED_ORDER_TEXT = "Оплата по этому заказу отменена. Заказ закрыт. Создайте новый заказ."


@dataclass(slots=True, frozen=True)
class OrderableGame:
    id: str
    key: str
    theme: str
    title: str
    category: str
    buy_callback: str
    description: str


ORDERABLE_GAMES: list[OrderableGame] = [
    OrderableGame(
        id=GAMES["RAILROAD"]["ID"],
        key=GAMES["RAILROAD"]["GAME_KEY"],
        theme=GAMES["RAILROAD"]["THEME"],
        title="Chicken Railroad",
        category=CATEGORIES["CHICKEN"],
        buy_callback="buy_check_railroad",
        description="Готовый однофайловый шаблон с железнодорожным игровым циклом.",
    ),
    OrderableGame(
        id=GAMES["OLYMPUS"]["ID"],
        key=GAMES["OLYMPUS"]["GAME_KEY"],
        theme=GAMES["OLYMPUS"]["THEME"],
        title="Gates of Olympus",
        category=CATEGORIES["SLOTS"],
        buy_callback="buy_check_olympus",
        description="Слот-шаблон с анимированным Zeus и сильным финальным экраном.",
    ),
    OrderableGame(
        id=GAMES["DRAG"]["ID"],
        key=GAMES["DRAG"]["GAME_KEY"],
        theme=GAMES["DRAG"]["THEME"],
        title="Money Matching",
        category=CATEGORIES["MATCHING"],
        buy_callback="buy_check_matching",
        description="Шаблон drag-and-drop matching с чистым CTA-флоу.",
    ),
    OrderableGame(
        id=GAMES["MATCH3"]["ID"],
        key=GAMES["MATCH3"]["GAME_KEY"],
        theme=GAMES["MATCH3"]["THEME"],
        title="3 v Ryad",
        category=CATEGORIES["MATCHING"],
        buy_callback="buy_check_match3",
        description="Быстрый шаблон match-3, оптимизированный под однофайловую выдачу.",
    ),
]

ORDERABLE_BY_BUY_CALLBACK = {game.buy_callback: game for game in ORDERABLE_GAMES}
ORDERABLE_BY_GAME_KEY = {game.key: game for game in ORDERABLE_GAMES}
ORDERABLE_BY_GAME_ID = {game.id: game for game in ORDERABLE_GAMES}

GAME_PREVIEW_PHOTOS: dict[str, list[Path]] = {
    GAMES["RAILROAD"]["GAME_KEY"]: [
        Path.cwd() / "assets" / "product_previews" / "railroad_preview.png",
    ],
    GAMES["OLYMPUS"]["GAME_KEY"]: [
        Path.cwd() / "assets" / "product_previews" / "olympus_preview.png",
        Path.cwd() / "templates" / "gate_of_olympus" / "bb16c47b-a4dc-48b5-9175-59a961b1122d.jpg",
        Path.cwd() / "templates" / "gate_of_olympus" / "dev" / "assets" / "bb16c47b-a4dc-48b5-9175-59a961b1122d.jpg",
    ],
    GAMES["DRAG"]["GAME_KEY"]: [
        Path.cwd() / "assets" / "product_previews" / "matching_preview.png",
        Path.cwd() / "templates" / "matching" / "assets" / "ChatGPT Image Dec 19, 2025, 02_59_23 PM.png",
    ],
    GAMES["MATCH3"]["GAME_KEY"]: [
        Path.cwd() / "assets" / "product_previews" / "match3_preview.png",
        Path.cwd() / "templates" / "3_v_ryad" / "public" / "assets" / "background.jpg",
        Path.cwd() / "templates" / "3_v_ryad" / "dist" / "assets" / "background.jpg",
    ],
}

GAME_CHANNEL_POSTS: dict[str, str] = {
    GAMES["RAILROAD"]["GAME_KEY"]: "https://t.me/rwbrr/290",
    GAMES["DRAG"]["GAME_KEY"]: "https://t.me/rwbrr/281",
    GAMES["MATCH3"]["GAME_KEY"]: "https://t.me/rwbrr/279",
    GAMES["OLYMPUS"]["GAME_KEY"]: "https://t.me/rwbrr/277",
    GAMES["PLINKO"]["GAME_KEY"]: "https://t.me/rwbrr/278",
}

router = Router()
session_store = FileSessionStore(SESSIONS_DIR)
bot_username_cache: str | None = None
SUPPORTED_LANGUAGES = {"ru", "en"}

TEXTS: dict[str, dict[str, str]] = {
    "ru": {
        "start_intro": "🎮 <b>HTML5 Playable бот</b>\n\n⚡ Выберите шаблон и GEO — бот автоматически соберет готовый playable.\n🌍 Поддержка разных стран и валют.\n🛠 Нужен уникальный креатив? Можно заказать кастомный playable.",
        "menu_home": "🏠 Главное меню",
        "menu_order": "🎮 Заказать плеебл",
        "menu_profile": "👤 Профиль",
        "menu_ref": "🤝 Реферальная система",
        "menu_support": "👨‍💻 Техподдержка",
        "menu_lang": "🌐 Язык",
        "back": "🔙 Назад",
        "choose_language": "Выберите язык интерфейса:",
        "language_saved_ru": "Язык переключен на русский.",
        "language_saved_en": "Language switched to English.",
        "choose_category": "Выберите категорию:",
        "choose_geo": "🌍 <b>Выберите GEO и валюту:</b>",
        "choose_geo_en": "🌍 <b>Choose GEO and currency:</b>",
        "ref_title": "Реферальная система:",
        "ref_link": "Ваша ссылка",
        "ref_invited": "Приглашено",
        "ref_balance": "Баланс",
        "top_up": "💰 Пополнить баланс",
    },
    "en": {
        "start_intro": "🎮 <b>HTML5 Playable bot</b>\n\n⚡ Choose a template and GEO, and the bot will auto-generate a ready playable.\n🌍 Supports multiple countries and currencies.\n🛠 Need a unique creative? You can order a custom playable.",
        "menu_home": "🏠 Main menu",
        "menu_order": "🎮 Launch a playable",
        "menu_profile": "👤 Profile",
        "menu_ref": "🤝 Partner program",
        "menu_support": "👨‍💻 Concierge support",
        "menu_lang": "🌐 Language",
        "back": "🔙 Back",
        "choose_language": "Choose interface language:",
        "language_saved_ru": "Язык переключен на русский.",
        "language_saved_en": "Language switched to English.",
        "choose_category": "Select your creative category:",
        "choose_geo": "🌍 <b>Выберите GEO и валюту:</b>",
        "choose_geo_en": "🌍 <b>Choose GEO and currency:</b>",
        "ref_title": "Partner program:",
        "ref_link": "Your link",
        "ref_invited": "Invited",
        "ref_balance": "Balance",
        "top_up": "💰 Fund balance",
    },
}

EN_TEXT_REPLACEMENTS: dict[str, str] = {
    "Ваш доступ к боту ограничен.": "Your access to the bot is restricted.",
    "Цена: ": "Price: ",
    "Оплатить в Crypto Bot": "Pay securely via Crypto Bot",
    "Проверить оплату": "Verify payment",
    "Отменить оплату": "Cancel payment",
    "Главное меню": "Main menu",
    "🎮 Новый заказ": "🎮 New order",
    "📝 Заказать своё GEO": "📝 Request custom GEO",
    "Отмена": "Cancel",
    "👀 Смотреть демо в канале": "👀 View premium demo",
    "🐔 Чикен": "🐔 Chicken",
    "🎱 Плинко": "🎱 Plinko",
    "🎰 Слоты": "🎰 Slots",
    "🧩 Метчинг": "🧩 Matching",
    "💳 Купить": "💳 Purchase",
    "Выберите игру:": "Choose a game:",
    "🤏 Перетаска": "🤏 Drag",
    "💎 3 в ряд": "💎 Match-3",
    "Некорректный выбор игры.": "Invalid game selection.",
    "Недостаточно прав.": "Insufficient permissions.",
    "Некорректная команда.": "Invalid command.",
    "Генерация уже выполняется. Подождите.": "Generation is already running. Please wait.",
    "Недостаточно средств на балансе.": "Your balance is currently insufficient.",
    "Пожалуйста, пополните счёт.": "Please add funds to continue.",
    "Сначала выберите игру.": "Choose a game first.",
    "Время ожидания истекло. Начните заказ заново.": "Timeout expired. Please start the order again.",
    "Нужна CTA-ссылка. Начните заказ заново и укажите корректную ссылку.": "A CTA link is required. Restart the order and provide a valid URL.",
    "Разово": "One-time",
    "Подписка": "Subscription",
    "Скидка": "Discount",
    "не задана": "not set",
    "пока не настроено": "not configured yet",
    "Выбранное GEO": "Selected GEO",
    "CTA-ссылка": "CTA link",
    "Проверьте демо и выберите формат покупки:": "Review the demo and choose your payment option:",
    "Оплатить напрямую (BTC/USDT)": "Pay directly (BTC/USDT wallet)",
    "Ошибка сборки.": "Build error.",
    "Ваш файл без водяного знака готов! 🚀": "Your file without watermark is ready! 🚀",
    "Ваш файл готов.": "Your file is ready.",
    "Некорректная ссылка оплаты.": "Invalid payment link.",
    "Заказ не найден.": "Order not found.",
    "Оплата уже подтверждена. Отмена недоступна.": "Payment is already confirmed. Cancellation is unavailable.",
    "Оплата отменена, заказ переведён в статус cancelled.": "Payment cancelled, order moved to cancelled status.",
    "Выберите тип прямой оплаты. После перевода отправьте TX hash или скриншот для ручной проверки.": "Choose a direct payment option. After transfer, send a TX hash or screenshot for manual review.",
    "Назад": "Back",
    "Я оплатил": "I paid",
    "Отправьте TX hash текстом или скриншот фото/документом.\nЧтобы отменить, отправьте /cancel.": "Send a TX hash as text or upload a screenshot (photo/document).\nTo cancel, send /cancel.",
    "Некорректная ссылка проверки оплаты.": "Invalid payment check link.",
    "Инвойс не найден. Отмените оплату и создайте новый заказ.": "Invoice not found. Cancel payment and create a new order.",
    "Инвойс не найден в Crypto Pay. Отмените оплату и создайте новый заказ.": "Invoice not found in Crypto Pay. Cancel payment and create a new order.",
    "Статус оплаты: ": "Payment status: ",
    "Завершите оплату и нажмите проверку снова.": "Complete the payment, then tap verify again.",
    "Ошибка обработки оплаты.": "Payment processing error.",
    "Оплата прошла! Собираю финальный файл...": "Payment confirmed. Preparing your production-ready file...",
    "Оплата уже подтверждена. Собираю финальный файл...": "Payment already confirmed. Final file is being prepared...",
    "Не удалось проверить оплату. Попробуйте ещё раз.": "We couldn't verify payment yet. Please try again.",
    "Инвойс создан на $": "Invoice created: $",
    "Оплатите и нажмите «Проверить оплату».": "Complete payment and tap \"Verify payment\".",
    "Не удалось создать инвойс Crypto Pay. Проверьте токен/настройки и попробуйте снова.": "Could not create Crypto Pay invoice. Check token/settings and try again.",
    "<b>Пополнение баланса</b>": "<b>Top up balance</b>",
    "Для пополнения баланса переведите средства на один из кошельков ниже:": "To top up your balance, transfer funds to one of the wallets below:",
    "После оплаты нажмите кнопку <b>«Я оплатил»</b>. Мы проверим транзакцию и зачислим баланс.": "After payment, click <b>\"I paid\"</b>. We will verify the transaction and credit your balance.",
    "✅ Я оплатил": "✅ I paid",
    "<b>Заявка отправлена!</b>\n\nАдминистратор скоро проверит платёж и зачислит средства на ваш баланс. Обычно это занимает от 5 до 30 минут.": "<b>Request submitted!</b>\n\nOur admin will verify the payment and credit your balance shortly. Usually this takes 5-30 minutes.",
    "Запрос на ручную оплату отменён.": "Manual payment request cancelled.",
    "Отправьте TX hash (текст) или скриншот (фото/документ).": "Send TX hash (text) or screenshot (photo/document).",
    "Заказ не найден. Начните заново из главного меню.": "Order not found. Start again from main menu.",
    "Подтверждение отправлено админу. После проверки вы получите готовый файл.": "Confirmation sent to admin. After review you will receive the final file.",
    "Время ожидания истекло. Начните заказ заново из главного меню.": "Timeout expired. Start the order again from main menu.",
    "Отправьте описание вашего GEO текстовым сообщением.": "Send your GEO description as text.",
    "Запрос на кастомный GEO пустой. Начните заново из меню.": "Custom GEO request is empty. Start again from menu.",
    "📩 <b>Ваш запрос отправлен админу!</b>\nМы свяжемся с вами в ближайшее время.": "📩 <b>Your request was sent to admin!</b>\nWe will contact you shortly.",
    "Отправьте CTA-ссылку текстом.": "Send CTA link as text.",
    "✅ <b>CTA-ссылка сохранена</b>": "✅ <b>CTA URL saved successfully</b>",
    "<b>Проверьте настройки заказа и создайте превью.</b>": "<b>Review your setup and generate a premium preview.</b>",
    "🚀 СОЗДАТЬ ПРЕВЬЮ": "🚀 GENERATE PREMIUM PREVIEW",
    "CTA-ссылка не задана. Начните заказ заново из главного меню.": "CTA link is not set. Start the order again from main menu.",
    "Некорректная ссылка. Отправьте валидный http/https URL, например https://example.com": "Invalid URL. Please send a valid http/https link, e.g. https://example.com",
    "✅ Стартовый баланс сохранен:": "✅ Starting balance saved:",
    "🔗 <b>Отправьте CTA-ссылку для редиректа</b>\nПример: <code>https://example.com</code>": "🔗 <b>Send CTA redirect link</b>\nExample: <code>https://example.com</code>",
    "Использован баланс по умолчанию:": "Default balance applied:",
    "Теперь отправьте CTA-ссылку.": "Now send your CTA URL.",
    "Введите корректное число для стартового баланса, например <code>1000</code>.": "Enter a valid starting balance number, e.g. <code>1000</code>.",
    "Пропустить (по умолчанию)": "Skip (default)",
    "Оплата по этому заказу отменена. Заказ закрыт. Создайте новый заказ.": "This payment was canceled. The order is closed, please create a new one.",
    "Ваш баланс пополнен на <b>$": "Your balance has been topped up by <b>$",
}


def _inline_keyboard(rows: list[list[InlineKeyboardButton]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=rows)


def t(lang: str, key: str) -> str:
    normalized = lang if lang in SUPPORTED_LANGUAGES else "ru"
    return TEXTS.get(normalized, TEXTS["ru"]).get(key, TEXTS["ru"].get(key, key))


def localize_text(text: str, lang: str) -> str:
    if lang != "en":
        return text
    localized = text
    for source, target in EN_TEXT_REPLACEMENTS.items():
        localized = localized.replace(source, target)
    return localized


def localize_inline_keyboard(markup: InlineKeyboardMarkup | None, lang: str) -> InlineKeyboardMarkup | None:
    if markup is None or lang != "en":
        return markup
    rows: list[list[InlineKeyboardButton]] = []
    for row in markup.inline_keyboard:
        next_row: list[InlineKeyboardButton] = []
        for button in row:
            next_row.append(
                InlineKeyboardButton(
                    text=localize_text(button.text, lang),
                    callback_data=button.callback_data,
                    url=button.url,
                    switch_inline_query=button.switch_inline_query,
                    switch_inline_query_current_chat=button.switch_inline_query_current_chat,
                    callback_game=button.callback_game,
                    pay=button.pay,
                )
            )
        rows.append(next_row)
    return InlineKeyboardMarkup(inline_keyboard=rows)


def localize_reply_keyboard(markup: ReplyKeyboardMarkup | None, lang: str) -> ReplyKeyboardMarkup | None:
    if markup is None or lang != "en":
        return markup
    rows: list[list[KeyboardButton]] = []
    for row in markup.keyboard:
        next_row: list[KeyboardButton] = []
        for button in row:
            next_row.append(KeyboardButton(text=localize_text(button.text, lang), request_user=button.request_user, request_chat=button.request_chat, request_contact=button.request_contact, request_location=button.request_location, request_poll=button.request_poll, web_app=button.web_app))
        rows.append(next_row)
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=markup.resize_keyboard, one_time_keyboard=markup.one_time_keyboard, input_field_placeholder=markup.input_field_placeholder, selective=markup.selective, is_persistent=markup.is_persistent)


async def answer_user(
    message: Message,
    text: str,
    reply_markup: InlineKeyboardMarkup | ReplyKeyboardMarkup | None = None,
) -> None:
    lang = await get_user_lang(message.from_user.id if message.from_user else 0)
    localized_text = localize_text(text, lang)
    localized_markup = reply_markup
    if isinstance(reply_markup, InlineKeyboardMarkup):
        localized_markup = localize_inline_keyboard(reply_markup, lang)
    elif isinstance(reply_markup, ReplyKeyboardMarkup):
        localized_markup = localize_reply_keyboard(reply_markup, lang)
    await message.answer(localized_text, reply_markup=localized_markup)


def build_main_menu_keyboard(lang: str) -> InlineKeyboardMarkup:
    return _inline_keyboard(
        [
            [InlineKeyboardButton(text=t(lang, "menu_order"), callback_data="order")],
            [InlineKeyboardButton(text=t(lang, "menu_profile"), callback_data="profile")],
            [InlineKeyboardButton(text=t(lang, "menu_ref"), callback_data="ref_system")],
            [InlineKeyboardButton(text=t(lang, "menu_lang"), callback_data="language_menu")],
            [InlineKeyboardButton(text=t(lang, "menu_support"), url="https://t.me/rawberrry")],
        ]
    )


def build_main_menu_nav(lang: str) -> InlineKeyboardMarkup:
    return _inline_keyboard([[InlineKeyboardButton(text=t(lang, "menu_home"), callback_data="main_menu")]])


def build_back_to_menu(lang: str) -> InlineKeyboardMarkup:
    return _inline_keyboard([[InlineKeyboardButton(text=t(lang, "back"), callback_data="main_menu")]])


def build_persistent_keyboard(lang: str) -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text=t(lang, "menu_home"))]],
        resize_keyboard=True,
    )


# Backward-compatible defaults for existing handlers not yet localized.
MAIN_MENU_NAV = build_main_menu_nav("ru")
WITH_BACK_TO_MENU = build_back_to_menu("ru")
PERSISTENT_KEYBOARD = build_persistent_keyboard("ru")


def _callback_message(callback: CallbackQuery) -> Message | None:
    return callback.message if isinstance(callback.message, Message) else None


def require_bot(obj: Message | CallbackQuery) -> Bot:
    bot = obj.bot
    if bot is None:
        raise RuntimeError("Bot is not attached")
    return bot


class BlockBannedMiddleware(BaseMiddleware):
    async def __call__(self, handler, event, data):
        user = getattr(event, "from_user", None)
        user_id = getattr(user, "id", None)
        if user_id is None:
            return await handler(event, data)

        if await DB.is_user_banned(int(user_id)):
            lang = await DB.get_user_language(int(user_id))
            if isinstance(event, CallbackQuery):
                try:
                    await event.answer(localize_text("Ваш доступ к боту ограничен.", lang), show_alert=True)
                except Exception:
                    pass
                return None
            if isinstance(event, Message):
                try:
                    await event.answer(localize_text("Ваш доступ к боту ограничен.", lang))
                except Exception:
                    pass
                return None
            return None

        return await handler(event, data)


async def _safe_delete_message(message: Message | None) -> None:
    if message is None:
        return
    try:
        await message.delete()
    except TelegramBadRequest:
        return


async def _reply_from_callback(callback: CallbackQuery, text: str, reply_markup: InlineKeyboardMarkup | None = None) -> None:
    lang = await get_user_lang(callback.from_user.id)
    localized_text = localize_text(text, lang)
    localized_markup = localize_inline_keyboard(reply_markup, lang)
    message = _callback_message(callback)
    if message is not None:
        await message.answer(localized_text, reply_markup=localized_markup)
        return
    await require_bot(callback).send_message(callback.from_user.id, localized_text, reply_markup=localized_markup)


async def edit_or_reply(callback: CallbackQuery, text: str, keyboard: InlineKeyboardMarkup | None = None) -> None:
    lang = await get_user_lang(callback.from_user.id)
    localized_text = localize_text(text, lang)
    localized_keyboard = localize_inline_keyboard(keyboard, lang)
    message = _callback_message(callback)
    if message is not None and message.text:
        try:
            await message.edit_text(localized_text, reply_markup=localized_keyboard)
            return
        except TelegramBadRequest:
            pass

    await _safe_delete_message(message)
    await _reply_from_callback(callback, localized_text, localized_keyboard)


def find_existing_preview_path(game_key: str) -> Path | None:
    candidates = GAME_PREVIEW_PHOTOS.get(game_key, [])
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def get_default_balance_for_game(game_key: str | None) -> int:
    if game_key in {GAMES["DRAG"]["GAME_KEY"], GAMES["MATCH3"]["GAME_KEY"]}:
        return 0
    return 1000


def parse_starting_balance(input_value: str) -> int | None:
    normalized = re.sub(r"[^\d]", "", input_value.strip())
    if not normalized:
        return None
    try:
        value = int(normalized)
    except ValueError:
        return None
    if value < 0 or value > 1_000_000_000:
        return None
    return value


def get_theme_for_game(game_key: str | None) -> str:
    for game in ORDERABLE_GAMES:
        if game.key == game_key:
            return game.theme
    return GAMES["RAILROAD"]["THEME"]


def get_channel_post_for_game(game_key: str | None) -> str | None:
    if not game_key:
        return None
    return GAME_CHANNEL_POSTS.get(game_key)


def clamp_discount(value: int) -> int:
    return max(0, min(90, int(value)))


def format_price_caption(base_price: int, discount: int) -> str:
    normalized = clamp_discount(discount)
    if normalized <= 0:
        return f"Цена: ${base_price}"
    discounted = calc_price(base_price, normalized)
    return f"Цена: <s>${base_price}</s> <b>${discounted}</b> (-{normalized}%)"


def normalize_cta_url(input_value: str) -> str | None:
    trimmed = input_value.strip()
    if not trimmed or len(trimmed) > MAX_CTA_URL_LENGTH:
        return None

    with_protocol = trimmed if re.match(r"^[a-zA-Z][a-zA-Z\d+\-.]*:", trimmed) else f"https://{trimmed}"
    parsed = urlparse(with_protocol)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not parsed.netloc:
        return None
    return with_protocol


def can_use_library_artifact(click_url: str | None) -> bool:
    return normalize_cta_url(click_url or "") is None


def build_crypto_invoice_keyboard(order_id: str, pay_url: str) -> InlineKeyboardMarkup:
    return _inline_keyboard(
        [
            [InlineKeyboardButton(text="Оплатить в Crypto Bot", url=pay_url)],
            [InlineKeyboardButton(text="Проверить оплату", callback_data=f"crypto_check_{order_id}")],
            [InlineKeyboardButton(text="Отменить оплату", callback_data=f"payment_cancel_{order_id}")],
            [InlineKeyboardButton(text="Главное меню", callback_data="main_menu")],
        ]
    )


def build_cancel_payment_keyboard(order_id: str) -> InlineKeyboardMarkup:
    return _inline_keyboard(
        [
            [InlineKeyboardButton(text="Отменить оплату", callback_data=f"payment_cancel_{order_id}")],
            [InlineKeyboardButton(text="Главное меню", callback_data="main_menu")],
        ]
    )


def build_cancelled_order_keyboard() -> InlineKeyboardMarkup:
    return _inline_keyboard(
        [
            [InlineKeyboardButton(text="🎮 Новый заказ", callback_data="order")],
            [InlineKeyboardButton(text="🏠 Главное меню", callback_data="main_menu")],
        ]
    )


def build_geo_keyboard() -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    current_row: list[InlineKeyboardButton] = []
    for geo in GEOS:
        current_row.append(InlineKeyboardButton(text=geo["name"], callback_data=f"geo_{geo['id']}"))
        if len(current_row) == 2:
            rows.append(current_row)
            current_row = []
    if current_row:
        rows.append(current_row)
    rows.append([InlineKeyboardButton(text="📝 Заказать своё GEO", callback_data="geo_custom")])
    rows.append([InlineKeyboardButton(text="Отмена", callback_data="main_menu")])
    return _inline_keyboard(rows)

async def get_session(user_id: int) -> dict[str, Any]:
    return await session_store.get(user_id)


async def save_session(user_id: int, session: dict[str, Any]) -> None:
    await session_store.save(user_id, session)


def get_session_config(session: dict[str, Any]) -> dict[str, Any]:
    config = session.get("config")
    if not isinstance(config, dict):
        session["config"] = {}
        config = session["config"]
    return config


def get_wizard(session: dict[str, Any]) -> dict[str, Any] | None:
    wizard = session.get("wizard")
    return wizard if isinstance(wizard, dict) else None


def set_wizard(session: dict[str, Any], stage: str, **extra: Any) -> None:
    payload = {"stage": stage, "updatedAt": int(datetime.now().timestamp() * 1000)}
    payload.update(extra)
    session["wizard"] = payload


def clear_wizard(session: dict[str, Any]) -> None:
    session.pop("wizard", None)


def wizard_expired(wizard: dict[str, Any]) -> bool:
    updated_at = int(wizard.get("updatedAt", 0))
    now = int(datetime.now().timestamp() * 1000)
    return (now - updated_at) > ORDER_WIZARD_TIMEOUT_MS


def is_order_cancelled(order: dict[str, Any] | None) -> bool:
    return bool(order and order.get("status") == ORDER_STATUS_CANCELLED)


async def get_effective_discount_for_game(user_id: int, game_key: str | None) -> dict[str, Any]:
    stats = await DB.get_user_stats(user_id)
    loyalty_discount = get_discount(stats.orders_paid)
    category = ORDERABLE_BY_GAME_KEY.get(game_key or "")
    category_discount = await DB.get_category_discount(category.category) if category else 0
    discount = max(loyalty_discount, category_discount)
    return {
        "stats": stats,
        "loyaltyDiscount": loyalty_discount,
        "categoryDiscount": category_discount,
        "discount": discount,
    }


async def get_discounted_amount(user_id: int, payment_type: str, game_key: str | None = None) -> dict[str, int]:
    pricing = await get_effective_discount_for_game(user_id, game_key)
    discount = int(pricing["discount"])
    amount = calc_price(CONFIG.prices.sub if payment_type == "sub" else CONFIG.prices.single, discount)
    return {"amount": amount, "discount": discount}


async def get_bot_username(bot: Bot) -> str:
    global bot_username_cache
    if bot_username_cache:
        return bot_username_cache
    me = await bot.get_me()
    bot_username_cache = me.username or "bot"
    return bot_username_cache


async def get_user_lang(user_id: int) -> str:
    return await DB.get_user_language(user_id)


async def show_main_menu(event: Message | CallbackQuery, delete_previous: bool = False) -> None:
    user_id = event.from_user.id
    lang = await get_user_lang(user_id)
    message = event if isinstance(event, Message) else _callback_message(event)
    if delete_previous and message is not None:
        await _safe_delete_message(message)

    welcome_path = BOT_ASSETS_DIR / "welcomer.png"
    cached_id = await DB.get_asset(ASSETS["WELCOME"])
    caption = ""

    try:
        if isinstance(event, Message):
            target = event
        else:
            target = message
            if target is None:
                await require_bot(event).send_message(
                    user_id,
                    t(lang, "menu_home"),
                    reply_markup=build_main_menu_keyboard(lang),
                )
                return

        if cached_id:
            await target.answer_photo(cached_id, caption=caption, reply_markup=build_main_menu_keyboard(lang))
            return

        if welcome_path.exists():
            sent = await target.answer_photo(FSInputFile(welcome_path), caption=caption, reply_markup=build_main_menu_keyboard(lang))
            if sent.photo:
                await DB.set_asset(ASSETS["WELCOME"], sent.photo[-1].file_id)
            return

        await target.answer(t(lang, "menu_home"), reply_markup=build_main_menu_keyboard(lang))
    except Exception:
        if isinstance(event, Message):
            await event.answer(t(lang, "menu_home"), reply_markup=build_main_menu_keyboard(lang))
        else:
            await _reply_from_callback(event, t(lang, "menu_home"), build_main_menu_keyboard(lang))


async def show_product_photo_card(callback: CallbackQuery, game: OrderableGame) -> None:
    lang = await get_user_lang(callback.from_user.id)
    pricing = await get_effective_discount_for_game(callback.from_user.id, game.key)
    single_price = calc_price(CONFIG.prices.single, pricing["discount"])
    caption = f"<b>{game.title}</b>\n\n{game.description}\n\n{format_price_caption(CONFIG.prices.single, pricing['discount'])}"
    rows: list[list[InlineKeyboardButton]] = []
    demo_url = get_channel_post_for_game(game.key)
    if demo_url:
        rows.append([InlineKeyboardButton(text="👀 Смотреть демо в канале", url=demo_url)])
    rows.extend(
        [
            [InlineKeyboardButton(text=f"💳 Купить (${single_price})", callback_data=game.buy_callback)],
            [InlineKeyboardButton(text="🔙 Назад", callback_data=game.category)],
        ]
    )
    keyboard = _inline_keyboard(rows)
    caption = localize_text(caption, lang)
    keyboard = localize_inline_keyboard(keyboard, lang) or keyboard
    cache_key = f"product_preview_v2_{game.key}"
    preview_path = find_existing_preview_path(game.key)

    message = _callback_message(callback)
    await _safe_delete_message(message)

    try:
        cached_id = await DB.get_asset(cache_key)
        if cached_id:
            if message is not None:
                await message.answer_photo(cached_id, caption=caption, reply_markup=keyboard)
            else:
                await require_bot(callback).send_photo(callback.from_user.id, cached_id, caption=caption, reply_markup=keyboard)
            return

        if preview_path and preview_path.exists():
            if message is not None:
                sent = await message.answer_photo(FSInputFile(preview_path), caption=caption, reply_markup=keyboard)
            else:
                sent = await require_bot(callback).send_photo(
                    callback.from_user.id,
                    FSInputFile(preview_path),
                    caption=caption,
                    reply_markup=keyboard,
                )
            if sent.photo:
                await DB.set_asset(cache_key, sent.photo[-1].file_id)
            return
    except Exception:
        logging.exception("Error sending photo preview for %s", game.key)

    await _reply_from_callback(callback, caption, keyboard)


async def start_order_wizard(callback: CallbackQuery, game: OrderableGame) -> None:
    user_id = callback.from_user.id
    session = await get_session(user_id)
    config = get_session_config(session)
    config.update(
        {
            "game": game.key,
            "themeId": game.theme,
            "startingBalance": get_default_balance_for_game(game.key),
        }
    )
    await DB.log_action(user_id, "auto_select_theme", game.theme)
    set_wizard(session, "geo")
    await save_session(user_id, session)
    lang = await get_user_lang(user_id)
    await _reply_from_callback(
        callback,
        t(lang, "choose_geo_en") if lang == "en" else t(lang, "choose_geo"),
        build_geo_keyboard(),
    )


@router.message(CommandStart())
async def on_start(message: Message, command: CommandObject) -> None:
    if message.from_user is None:
        return
    user = message.from_user

    await DB.upsert_user(user.id, user.username, user.first_name)
    existing_lang = await DB.get_user_language(user.id)
    if existing_lang == "ru":
        preferred = "en" if (user.language_code or "").lower().startswith("en") else "ru"
        if preferred != existing_lang:
            await DB.set_user_language(user.id, preferred)
    lang = await DB.get_user_language(user.id)
    await DB.log_action(user.id, "start_bot")

    if command.args:
        try:
            ref_id = int(command.args)
        except ValueError:
            ref_id = -1
        if ref_id > 0:
            ok = await DB.set_referrer(user.id, ref_id)
            if ok:
                await DB.log_action(user.id, "referral_join", f"Ref: {ref_id}")

    await message.answer(t(lang, "start_intro"), reply_markup=build_persistent_keyboard(lang))
    await show_main_menu(message)


@router.callback_query(F.data == "delete_this")
async def on_delete_this(callback: CallbackQuery) -> None:
    await callback.answer()
    await _safe_delete_message(_callback_message(callback))


@router.callback_query(F.data == "main_menu")
async def on_main_menu(callback: CallbackQuery) -> None:
    await callback.answer()
    await show_main_menu(callback, delete_previous=True)


@router.callback_query(F.data == "language_menu")
async def on_language_menu(callback: CallbackQuery) -> None:
    await callback.answer()
    lang = await get_user_lang(callback.from_user.id)
    await edit_or_reply(
        callback,
        t(lang, "choose_language"),
        _inline_keyboard(
            [
                [InlineKeyboardButton(text="Русский", callback_data="set_lang_ru")],
                [InlineKeyboardButton(text="English", callback_data="set_lang_en")],
                [InlineKeyboardButton(text=t(lang, "back"), callback_data="main_menu")],
            ]
        ),
    )


@router.callback_query(F.data.in_({"set_lang_ru", "set_lang_en"}))
async def on_set_language(callback: CallbackQuery) -> None:
    await callback.answer()
    lang = "en" if callback.data == "set_lang_en" else "ru"
    await DB.set_user_language(callback.from_user.id, lang)
    await _reply_from_callback(
        callback,
        t(lang, "language_saved_en") if lang == "en" else t(lang, "language_saved_ru"),
        build_main_menu_nav(lang),
    )
    await show_main_menu(callback, delete_previous=True)


@router.message(F.text.in_({"🏠 Главное меню", "🏠 Main menu"}))
async def on_keyboard_main_menu(message: Message) -> None:
    await show_main_menu(message)


@router.callback_query(F.data == "order")
async def on_order(callback: CallbackQuery) -> None:
    await callback.answer()
    await DB.log_action(callback.from_user.id, "start_order")
    lang = await get_user_lang(callback.from_user.id)
    await edit_or_reply(
        callback,
        t(lang, "choose_category"),
        _inline_keyboard(
            [
                [
                    InlineKeyboardButton(text="🐔 Чикен", callback_data=CATEGORIES["CHICKEN"]),
                    InlineKeyboardButton(text="🎱 Плинко", callback_data=CATEGORIES["PLINKO"]),
                ],
                [
                    InlineKeyboardButton(text="🎰 Слоты", callback_data=CATEGORIES["SLOTS"]),
                    InlineKeyboardButton(text="🧩 Метчинг", callback_data=CATEGORIES["MATCHING"]),
                ],
                [InlineKeyboardButton(text=t(lang, "back"), callback_data="main_menu")],
            ]
        ),
    )


@router.callback_query(F.data == CATEGORIES["CHICKEN"])
async def on_cat_chicken(callback: CallbackQuery) -> None:
    await callback.answer()
    await edit_or_reply(
        callback,
        "Выберите игру:",
        _inline_keyboard(
            [
                [InlineKeyboardButton(text="🚂 Chicken Railroad", callback_data=GAMES["RAILROAD"]["ID"])],
                [InlineKeyboardButton(text="🔙 Назад", callback_data="order")],
            ]
        ),
    )


@router.callback_query(F.data == CATEGORIES["PLINKO"])
async def on_cat_plinko(callback: CallbackQuery) -> None:
    await callback.answer()
    await edit_or_reply(
        callback,
        "Выберите игру:",
        _inline_keyboard(
            [
                [InlineKeyboardButton(text="🎱 Classic Plinko", callback_data=GAMES["PLINKO"]["ID"])],
                [InlineKeyboardButton(text="🔙 Назад", callback_data="order")],
            ]
        ),
    )


@router.callback_query(F.data == CATEGORIES["SLOTS"])
async def on_cat_slots(callback: CallbackQuery) -> None:
    await callback.answer()
    await edit_or_reply(
        callback,
        "Выберите игру:",
        _inline_keyboard(
            [
                [InlineKeyboardButton(text="⚡ Gates of Olympus", callback_data=GAMES["OLYMPUS"]["ID"])],
                [InlineKeyboardButton(text="🔙 Назад", callback_data="order")],
            ]
        ),
    )


@router.callback_query(F.data == CATEGORIES["MATCHING"])
async def on_cat_matching(callback: CallbackQuery) -> None:
    await callback.answer()
    await edit_or_reply(
        callback,
        "Выберите игру:",
        _inline_keyboard(
            [
                [InlineKeyboardButton(text="🤏 Перетаска", callback_data=GAMES["DRAG"]["ID"])],
                [InlineKeyboardButton(text="💎 3 в ряд", callback_data=GAMES["MATCH3"]["ID"])],
                [InlineKeyboardButton(text="🔙 Назад", callback_data="order")],
            ]
        ),
    )

@router.callback_query(F.data == GAMES["RAILROAD"]["ID"])
async def on_game_railroad(callback: CallbackQuery) -> None:
    await callback.answer()
    lang = await get_user_lang(callback.from_user.id)
    await DB.log_action(callback.from_user.id, "view_product", "railroad")

    preview_cache_key = f"product_preview_v2_{GAMES['RAILROAD']['GAME_KEY']}"
    preview_path = find_existing_preview_path(GAMES["RAILROAD"]["GAME_KEY"])
    pricing = await get_effective_discount_for_game(callback.from_user.id, GAMES["RAILROAD"]["GAME_KEY"])
    single_price = calc_price(CONFIG.prices.single, pricing["discount"])
    caption = (
        "<b>🚂 Chicken Railroad</b>\n\n"
        "Увлекательная игра, где нужно строить пути для курочки! Отличный выбор для повышения вовлеченности.\n\n"
        f"{format_price_caption(CONFIG.prices.single, pricing['discount'])}"
    )

    keyboard = _inline_keyboard(
        [
            [InlineKeyboardButton(text="👀 Смотреть демо в канале", url=get_channel_post_for_game(GAMES["RAILROAD"]["GAME_KEY"]) or "https://t.me/rwbrr")],
            [InlineKeyboardButton(text=f"💳 Купить (${single_price})", callback_data="buy_check_railroad")],
            [InlineKeyboardButton(text="🔙 Назад", callback_data=CATEGORIES["CHICKEN"])],
        ]
    )
    caption = localize_text(caption, lang)
    keyboard = localize_inline_keyboard(keyboard, lang) or keyboard

    message = _callback_message(callback)
    await _safe_delete_message(message)

    try:
        cached_id = await DB.get_asset(preview_cache_key)
        if cached_id:
            if message is not None:
                await message.answer_photo(cached_id, caption=caption, reply_markup=keyboard)
            else:
                await require_bot(callback).send_photo(callback.from_user.id, cached_id, caption=caption, reply_markup=keyboard)
            return
        if preview_path and preview_path.exists():
            if message is not None:
                sent = await message.answer_photo(FSInputFile(preview_path), caption=caption, reply_markup=keyboard)
            else:
                sent = await require_bot(callback).send_photo(
                    callback.from_user.id, FSInputFile(preview_path), caption=caption, reply_markup=keyboard
                )
            if sent.photo:
                await DB.set_asset(preview_cache_key, sent.photo[-1].file_id)
            return
    except Exception:
        logging.exception("Error sending product page")

    await _reply_from_callback(callback, caption, keyboard)


@router.callback_query(F.data.in_({GAMES["OLYMPUS"]["ID"], GAMES["DRAG"]["ID"], GAMES["MATCH3"]["ID"]}))
async def on_game_cards(callback: CallbackQuery) -> None:
    await callback.answer()
    game = ORDERABLE_BY_GAME_ID.get(callback.data or "")
    if not game:
        return
    await DB.log_action(callback.from_user.id, "view_product", game.key)
    await show_product_photo_card(callback, game)


@router.callback_query(F.data == GAMES["PLINKO"]["ID"])
async def on_game_plinko(callback: CallbackQuery) -> None:
    await callback.answer()
    demo_url = get_channel_post_for_game(GAMES["PLINKO"]["GAME_KEY"]) or "https://t.me/rwbrr"
    await edit_or_reply(
        callback,
        "<b>💣 Бомбы</b>\n\nДемо доступно в канале. Заказ в боте скоро добавим.",
        _inline_keyboard(
            [
                [InlineKeyboardButton(text="👀 Смотреть демо в канале", url=demo_url)],
                [InlineKeyboardButton(text="🔙 Назад", callback_data=CATEGORIES["PLINKO"])],
            ]
        ),
    )


@router.callback_query(F.data.regexp(r"^buy_check_"))
async def on_buy_check(callback: CallbackQuery) -> None:
    await callback.answer()
    game = ORDERABLE_BY_BUY_CALLBACK.get(callback.data or "")
    if not game:
        await edit_or_reply(callback, "Некорректный выбор игры.", WITH_BACK_TO_MENU)
        return

    pricing = await get_effective_discount_for_game(callback.from_user.id, game.key)
    min_price = calc_price(CONFIG.prices.single, pricing["discount"])
    crypto_enabled = is_crypto_pay_enabled()

    if not crypto_enabled and pricing["stats"].wallet_balance < min_price:
        await _reply_from_callback(
            callback,
            f"Недостаточно средств на балансе.\nВаш баланс: ${pricing['stats'].wallet_balance}\n"
            f"Требуется: ${min_price}\n\nПожалуйста, пополните счёт.",
            _inline_keyboard([[InlineKeyboardButton(text="🔙 Назад", callback_data="delete_this")]]),
        )
        return

    await DB.log_action(callback.from_user.id, "select_game", game.key)
    await start_order_wizard(callback, game)


@router.callback_query(F.data.regexp(r"^geo_"))
async def on_geo_select(callback: CallbackQuery) -> None:
    await callback.answer()
    user_id = callback.from_user.id
    session = await get_session(user_id)
    wizard = get_wizard(session)
    if not wizard or wizard.get("stage") != "geo":
        lang = await get_user_lang(callback.from_user.id)
        await callback.answer(localize_text("Сначала выберите игру.", lang), show_alert=False)
        return
    if wizard_expired(wizard):
        clear_wizard(session)
        await save_session(user_id, session)
        await edit_or_reply(callback, "Время ожидания истекло. Начните заказ заново.", WITH_BACK_TO_MENU)
        return

    geo_payload = (callback.data or "").replace("geo_", "")
    if geo_payload == "custom":
        pending_count = await DB.count_orders_by_status(user_id, "custom_pending")
        if pending_count >= 3:
            await _reply_from_callback(
                callback,
                "⏳ <b>У вас уже есть 3 активных запроса.</b>\nПожалуйста, дождитесь ответа техподдержки.",
            )
            return
        set_wizard(session, "custom_geo_desc")
        await save_session(user_id, session)
        await _reply_from_callback(callback, "💬 <b>Опишите нужное вам GEO (язык, валюта):</b>")
        return

    selected_geo = next((geo for geo in GEOS if geo["id"] == geo_payload), None)
    if selected_geo is None:
        return

    config = get_session_config(session)
    config["language"] = selected_geo["lang"]
    config["currency"] = selected_geo["currency"]
    config["geoId"] = geo_payload
    await DB.log_action(user_id, "select_geo", geo_payload)

    set_wizard(session, "starting_balance", attempts=0)
    await save_session(user_id, session)
    await _reply_from_callback(
        callback,
        "✅ <b>Настройки GEO применены!</b>\n"
        f"🌍 Выбранное GEO: <b>{selected_geo['name']}</b>\n"
        f"💱 Валюта: <b>{selected_geo['currency']}</b>\n\n"
        "Введите стартовый баланс плеебла (только число):",
    )
    return


@router.callback_query(F.data == "skip_starting_balance")
async def on_skip_starting_balance(callback: CallbackQuery) -> None:
    await callback.answer()
    user_id = callback.from_user.id
    session = await get_session(user_id)
    wizard = get_wizard(session)
    if not wizard or wizard.get("stage") != "starting_balance":
        return
    if wizard_expired(wizard):
        clear_wizard(session)
        await save_session(user_id, session)
        await edit_or_reply(callback, "Время ожидания истекло. Начните заказ заново.", WITH_BACK_TO_MENU)
        return
    config = get_session_config(session)
    default_balance = get_default_balance_for_game(config.get("game"))
    config["startingBalance"] = default_balance
    await DB.log_action(user_id, "set_starting_balance", str(default_balance))
    set_wizard(session, "cta_url", attempts=0)
    await save_session(user_id, session)
    await _reply_from_callback(callback, f"✅ Стартовый баланс установлен: <b>{default_balance}</b>")
    await _reply_from_callback(
        callback,
        "🔗 <b>Отправьте CTA-ссылку для редиректа</b>\nПример: <code>https://example.com</code>",
    )


@router.callback_query(F.data == "gen_preview")
async def on_gen_preview(callback: CallbackQuery) -> None:
    user_id = callback.from_user.id
    session = await get_session(user_id)
    if session.get("previewInProgress"):
        lang = await get_user_lang(callback.from_user.id)
        await callback.answer(localize_text("Генерация уже выполняется. Подождите.", lang), show_alert=False)
        return

    session["previewInProgress"] = True
    await save_session(user_id, session)
    await callback.answer()

    order_id: str | None = None
    try:
        await DB.log_action(user_id, "gen_preview")
        config = get_session_config(session)
        if not config.get("themeId"):
            await edit_or_reply(callback, "Нет активной конфигурации.", WITH_BACK_TO_MENU)
            return

        valid_click_url = normalize_cta_url(str(config.get("clickUrl", "")))
        if not valid_click_url:
            last_click_log = await DB.get_last_log_by_action(user_id, "set_click_url")
            restored = normalize_cta_url(str(last_click_log.get("details", ""))) if last_click_log else None
            if restored:
                config["clickUrl"] = restored
                valid_click_url = restored
                await DB.log_action(user_id, "restore_click_url", restored)
        if not valid_click_url:
            await edit_or_reply(
                callback,
                "Нужна CTA-ссылка. Начните заказ заново и укажите корректную ссылку.",
                WITH_BACK_TO_MENU,
            )
            return
        config["clickUrl"] = valid_click_url
        await save_session(user_id, session)

        order_id = f"ord_{user_id}_{int(datetime.now().timestamp() * 1000)}"
        await DB.create_order(order_id, user_id, str(config.get("game", "railroad")), str(config["themeId"]), config)

        pricing = await get_effective_discount_for_game(user_id, str(config.get("game", GAMES["RAILROAD"]["GAME_KEY"])))
        p1 = calc_price(CONFIG.prices.single, pricing["discount"])
        p2 = calc_price(CONFIG.prices.sub, pricing["discount"])
        single_line = (
            f"Разово: <s>${CONFIG.prices.single}</s> <b>${p1}</b>"
            if pricing["discount"] > 0
            else f"Разово: ${p1}"
        )
        sub_line = (
            f"Подписка: <s>${CONFIG.prices.sub}</s> <b>${p2}</b>"
            if pricing["discount"] > 0
            else f"Подписка: ${p2}"
        )
        discount_caption = f"Скидка: {pricing['discount']}%" if pricing["discount"] > 0 else "Скидка: 0%"
        demo_url = get_channel_post_for_game(str(config.get("game", GAMES["RAILROAD"]["GAME_KEY"])))
        selected_geo = str(config.get("geoId", "en_usd"))
        cta_text = escape(str(config.get("clickUrl", "не задана")))
        demo_line = f"👀 <b>Демо в канале:</b>\n{demo_url}" if demo_url else "👀 <b>Демо в канале:</b>\n<i>пока не настроено</i>"

        await edit_or_reply(
            callback,
            f"{demo_line}\n\n🌍 <b>Выбранное GEO:</b> <code>{selected_geo}</code>\n"
            f"🔗 <b>CTA-ссылка:</b> <code>{cta_text}</code>\n\n"
            f"💸 <b>{discount_caption}</b>\n{single_line}\n{sub_line}\n\n"
            f"<i>Проверьте демо и выберите формат покупки:</i>",
            _inline_keyboard(
                [
                    [InlineKeyboardButton(text="👀 Смотреть демо в канале", url=demo_url or "https://t.me/rwbrr")],
                    [InlineKeyboardButton(text=f"💳 Купить разово ($ {p1})", callback_data=f"pay_single_{order_id}")],
                    [InlineKeyboardButton(text=f"⭐ Подписка ($ {p2})", callback_data=f"pay_sub_{order_id}")],
                    [InlineKeyboardButton(text="Оплатить напрямую (BTC/USDT)", callback_data=f"manual_pay_menu_{order_id}")],
                    [InlineKeyboardButton(text="🏠 Главное меню", callback_data="main_menu")],
                ]
            ),
        )
    except Exception:
        logging.exception("Preview presentation error")
        if order_id:
            try:
                await DB.set_order_status(order_id, "preview_failed")
            except DBError:
                pass
        await edit_or_reply(callback, "Ошибка при подготовке демо. Попробуйте снова через минуту.", WITH_BACK_TO_MENU)
    finally:
        refreshed = await get_session(user_id)
        refreshed["previewInProgress"] = False
        await save_session(user_id, refreshed)

async def build_final_order_path(order_id: str, order: dict[str, Any]) -> str | None:
    config = order.get("config", {})
    click_url = config.get("clickUrl") if isinstance(config, dict) else None
    lib_path = (
        get_library_path(
            str(order.get("gameType", "")),
            str(config.get("geoId", "en_usd")),
            False,
        )
        if can_use_library_artifact(click_url)
        else None
    )

    if lib_path:
        logging.info("[Library] Delivering pre-built final: %s", lib_path)
        return lib_path

    final_config = dict(config) if isinstance(config, dict) else {}
    final_config["isWatermarked"] = False
    return await generate_playable(f"{order_id}_final", final_config)


async def deliver_final_order(callback: CallbackQuery, order_id: str, order: dict[str, Any], status_text: str) -> None:
    lang = await get_user_lang(callback.from_user.id)
    await edit_or_reply(callback, status_text)
    await asyncio.sleep(FINAL_DELIVERY_DELAY_SECONDS)
    final_path = await build_final_order_path(order_id, order)
    if final_path:
        message = _callback_message(callback)
        doc = FSInputFile(final_path)
        if message is not None:
            await message.answer_document(
                doc,
                caption=localize_text("Ваш файл без водяного знака готов! 🚀", lang),
                reply_markup=build_main_menu_nav(lang),
            )
        else:
            await require_bot(callback).send_document(
                callback.from_user.id,
                doc,
                caption=localize_text("Ваш файл без водяного знака готов! 🚀", lang),
                reply_markup=build_main_menu_nav(lang),
            )
        return
    await edit_or_reply(callback, "Ошибка сборки.", WITH_BACK_TO_MENU)


def get_stored_crypto_payment(order: dict[str, Any]) -> dict[str, Any] | None:
    config = order.get("config")
    if not isinstance(config, dict):
        return None
    payment = config.get("payment")
    if not isinstance(payment, dict):
        return None
    if payment.get("provider") != "crypto_pay":
        return None

    try:
        invoice_id = int(payment.get("invoiceId"))
        amount = int(payment.get("amount"))
        discount = int(payment.get("discount"))
    except (TypeError, ValueError):
        return None

    payment_type = payment.get("type")
    pay_url = payment.get("payUrl")
    if payment_type not in {"single", "sub"}:
        return None
    if invoice_id <= 0 or amount <= 0 or discount < 0:
        return None
    if not isinstance(pay_url, str):
        pay_url = ""

    return {
        "invoiceId": invoice_id,
        "amount": amount,
        "discount": discount,
        "type": payment_type,
        "payUrl": pay_url,
    }


@router.callback_query(F.data.regexp(r"^payment_cancel_"))
async def on_payment_cancel(callback: CallbackQuery) -> None:
    await callback.answer()
    user_id = callback.from_user.id
    order_id = (callback.data or "").replace("payment_cancel_", "")
    if not order_id:
        await edit_or_reply(callback, "Некорректная ссылка оплаты.", WITH_BACK_TO_MENU)
        return

    order = await DB.get_order(order_id)
    if not order or int(order.get("userId", 0)) != user_id:
        await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
        return
    if str(order.get("status", "")).startswith("paid"):
        await edit_or_reply(callback, "Оплата уже подтверждена. Отмена недоступна.", MAIN_MENU_NAV)
        return
    if is_order_cancelled(order):
        await edit_or_reply(callback, CANCELLED_ORDER_TEXT, build_cancelled_order_keyboard())
        return

    await DB.set_order_status(order_id, ORDER_STATUS_CANCELLED)
    session = await get_session(user_id)
    pending = session.get("pendingManualPayment")
    if isinstance(pending, dict) and pending.get("orderId") == order_id:
        session.pop("pendingManualPayment", None)
    await save_session(user_id, session)
    await DB.log_action(user_id, "payment_cancelled_by_user", order_id)
    await edit_or_reply(
        callback,
        "Оплата отменена, заказ переведён в статус cancelled.",
        build_cancelled_order_keyboard(),
    )


@router.callback_query(F.data.regexp(r"^manual_pay_menu_"))
async def on_manual_pay_menu(callback: CallbackQuery) -> None:
    await callback.answer()
    order_id = (callback.data or "").replace("manual_pay_menu_", "")
    if not order_id:
        await edit_or_reply(callback, "Некорректная ссылка оплаты.", WITH_BACK_TO_MENU)
        return
    order = await DB.get_order(order_id)
    if not order or int(order.get("userId", 0)) != callback.from_user.id:
        await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
        return
    if is_order_cancelled(order):
        await edit_or_reply(callback, CANCELLED_ORDER_TEXT, build_cancelled_order_keyboard())
        return

    single = await get_discounted_amount(callback.from_user.id, "single", str(order.get("gameType")))
    sub = await get_discounted_amount(callback.from_user.id, "sub", str(order.get("gameType")))
    await DB.log_action(callback.from_user.id, "manual_pay_menu_open", order_id)
    await edit_or_reply(
        callback,
        "Выберите тип прямой оплаты. После перевода отправьте TX hash или скриншот для ручной проверки.",
        _inline_keyboard(
            [
                [InlineKeyboardButton(text=f"Разово ${single['amount']}", callback_data=f"manual_pay_single_{order_id}")],
                [InlineKeyboardButton(text=f"Подписка ${sub['amount']}", callback_data=f"manual_pay_sub_{order_id}")],
                [InlineKeyboardButton(text="Главное меню", callback_data="main_menu")],
            ]
        ),
    )


@router.callback_query(F.data.regexp(r"^manual_pay_(single|sub)_"))
async def on_manual_pay_type(callback: CallbackQuery) -> None:
    await callback.answer()
    match = re.match(r"^manual_pay_(single|sub)_(.+)$", callback.data or "")
    if not match:
        await edit_or_reply(callback, "Некорректная ссылка оплаты.", WITH_BACK_TO_MENU)
        return
    payment_type, order_id = match.group(1), match.group(2)

    order = await DB.get_order(order_id)
    if not order or int(order.get("userId", 0)) != callback.from_user.id:
        await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
        return
    if is_order_cancelled(order):
        await edit_or_reply(callback, CANCELLED_ORDER_TEXT, build_cancelled_order_keyboard())
        return

    discounted = await get_discounted_amount(callback.from_user.id, payment_type, str(order.get("gameType")))
    await DB.update_order_config(
        order_id,
        {
            "manualPayment": {
                "provider": "direct_wallet",
                "type": payment_type,
                "amount": discounted["amount"],
                "discount": discounted["discount"],
                "state": "awaiting_transfer",
                "updatedAt": datetime.now(UTC).isoformat(),
            }
        },
    )
    await DB.set_order_status(order_id, "manual_transfer_pending")
    await DB.log_action(
        callback.from_user.id,
        "manual_payment_requested",
        f"{order_id}:{payment_type}:${discounted['amount']}",
    )

    message = (
        f"<b>Прямая оплата заказа {order_id}</b>\n\n"
        f"<b>Сумма:</b> ${discounted['amount']}\n"
        f"<b>USDT TRC-20:</b>\n<code>{CONFIG.wallets.usdt_trc20}</code>\n\n"
        f"<b>BTC:</b>\n<code>{CONFIG.wallets.btc}</code>\n\n"
        "После перевода нажмите <b>Я оплатил</b> и отправьте TX hash или скриншот."
    )
    await edit_or_reply(
        callback,
        message,
        _inline_keyboard(
            [
                [InlineKeyboardButton(text="Я оплатил", callback_data=f"manual_paid_{payment_type}_{order_id}")],
                [InlineKeyboardButton(text="Назад", callback_data=f"manual_pay_menu_{order_id}")],
                [InlineKeyboardButton(text="Главное меню", callback_data="main_menu")],
            ]
        ),
    )


@router.callback_query(F.data.regexp(r"^manual_paid_(single|sub)_"))
async def on_manual_paid(callback: CallbackQuery) -> None:
    await callback.answer()
    match = re.match(r"^manual_paid_(single|sub)_(.+)$", callback.data or "")
    if not match:
        await edit_or_reply(callback, "Некорректная ссылка оплаты.", WITH_BACK_TO_MENU)
        return

    payment_type, order_id = match.group(1), match.group(2)
    order = await DB.get_order(order_id)
    if not order or int(order.get("userId", 0)) != callback.from_user.id:
        await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
        return
    if is_order_cancelled(order):
        await edit_or_reply(callback, CANCELLED_ORDER_TEXT, build_cancelled_order_keyboard())
        return

    discounted = await get_discounted_amount(callback.from_user.id, payment_type, str(order.get("gameType")))
    session = await get_session(callback.from_user.id)
    session["pendingManualPayment"] = {
        "orderId": order_id,
        "paymentType": payment_type,
        "amount": discounted["amount"],
    }
    await save_session(callback.from_user.id, session)
    await DB.set_order_status(order_id, "manual_proof_requested")
    await DB.log_action(
        callback.from_user.id,
        "manual_payment_waiting_proof",
        f"{order_id}:{payment_type}:${discounted['amount']}",
    )
    await edit_or_reply(
        callback,
        "Отправьте TX hash текстом или скриншот фото/документом.\nЧтобы отменить, отправьте /cancel.",
        _inline_keyboard([[InlineKeyboardButton(text="Главное меню", callback_data="main_menu")]]),
    )


@router.callback_query(F.data.regexp(r"^crypto_check_"))
async def on_crypto_check(callback: CallbackQuery) -> None:
    await callback.answer()
    user_id = callback.from_user.id
    order_id = (callback.data or "").replace("crypto_check_", "")
    if not order_id:
        await edit_or_reply(callback, "Некорректная ссылка проверки оплаты.", WITH_BACK_TO_MENU)
        return

    order = await DB.get_order(order_id)
    if not order or int(order.get("userId", 0)) != user_id:
        await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
        return
    if is_order_cancelled(order):
        await edit_or_reply(callback, CANCELLED_ORDER_TEXT, build_cancelled_order_keyboard())
        return

    payment = get_stored_crypto_payment(order)
    if not payment:
        await edit_or_reply(
            callback,
            "Инвойс не найден. Отмените оплату и создайте новый заказ.",
            build_cancel_payment_keyboard(order_id),
        )
        return

    if str(order.get("status", "")).startswith("paid"):
        await deliver_final_order(callback, order_id, order, "Оплата уже подтверждена. Собираю финальный файл...")
        return

    await DB.log_action(user_id, "crypto_pay_check", f"{order_id}:{payment['invoiceId']}")

    try:
        invoice = await get_crypto_pay_invoice(int(payment["invoiceId"]))
        if not invoice:
            await edit_or_reply(
                callback,
                "Инвойс не найден в Crypto Pay. Отмените оплату и создайте новый заказ.",
                build_cancel_payment_keyboard(order_id),
            )
            return

        status = invoice.status.lower()
        if status != "paid":
            keyboard = build_crypto_invoice_keyboard(order_id, invoice.pay_url) if invoice.pay_url else build_cancel_payment_keyboard(order_id)
            await edit_or_reply(
                callback,
                f"Статус оплаты: {invoice.status}. Завершите оплату и нажмите проверку снова.",
                keyboard,
            )
            return

        already_paid = False
        try:
            await DB.finalize_external_paid_order(
                order_id,
                user_id,
                f"paid_{payment['type']}",
                int(payment["amount"]),
                int(payment["discount"]),
            )
            await DB.add_referral_reward(user_id, int(payment["amount"]))
            await DB.log_action(user_id, "pay_success_crypto", f"${payment['amount']}")
        except DBError as exc:
            if str(exc) == "ORDER_ALREADY_PAID":
                already_paid = True
            elif str(exc) in {"ORDER_NOT_FOUND", "ORDER_USER_MISMATCH"}:
                await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
                return
            else:
                logging.exception("Crypto payment finalize error")
                await edit_or_reply(callback, "Ошибка обработки оплаты.", WITH_BACK_TO_MENU)
                return

        fresh_order = await DB.get_order(order_id)
        if not fresh_order:
            await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
            return
        await deliver_final_order(
            callback,
            order_id,
            fresh_order,
            "Оплата уже подтверждена. Собираю финальный файл..."
            if already_paid
            else "Оплата прошла! Собираю финальный файл...",
        )
    except Exception:
        logging.exception("Crypto payment check error")
        await edit_or_reply(callback, "Не удалось проверить оплату. Попробуйте ещё раз.", WITH_BACK_TO_MENU)

@router.callback_query(F.data.regexp(r"^pay_"))
async def on_pay(callback: CallbackQuery) -> None:
    await callback.answer()
    user_id = callback.from_user.id
    parsed = parse_pay_callback(callback.data or "")
    if not parsed:
        await edit_or_reply(callback, "Некорректная ссылка оплаты.", WITH_BACK_TO_MENU)
        return

    order = await DB.get_order(parsed["orderId"])
    if not order or int(order.get("userId", 0)) != user_id:
        await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
        return
    if is_order_cancelled(order):
        await edit_or_reply(callback, CANCELLED_ORDER_TEXT, build_cancelled_order_keyboard())
        return

    await DB.log_action(user_id, "pay_click", parsed["type"])

    if is_crypto_pay_enabled():
        if str(order.get("status", "")).startswith("paid"):
            await deliver_final_order(callback, parsed["orderId"], order, "Оплата уже подтверждена. Собираю финальный файл...")
            return

        discounted = await get_discounted_amount(user_id, parsed["type"], str(order.get("gameType")))
        try:
            invoice = await create_crypto_pay_invoice(
                CreateInvoiceParams(
                    amount_usd=discounted["amount"],
                    description=f"Оплата заказа {order['orderId']} ({parsed['type']})",
                    payload=f"{parsed['orderId']}:{user_id}:{parsed['type']}",
                    expires_in_seconds=3600,
                )
            )
            await DB.update_order_config(
                parsed["orderId"],
                {
                    "payment": {
                        "provider": "crypto_pay",
                        "invoiceId": invoice.invoice_id,
                        "payUrl": invoice.pay_url,
                        "type": parsed["type"],
                        "amount": discounted["amount"],
                        "discount": discounted["discount"],
                        "createdAt": datetime.now(UTC).isoformat(),
                    }
                },
            )
            await DB.log_action(
                user_id,
                "crypto_invoice_created",
                f"{parsed['orderId']}:{invoice.invoice_id}:${discounted['amount']}",
            )
            await edit_or_reply(
                callback,
                f"Инвойс создан на ${discounted['amount']}. Оплатите и нажмите «Проверить оплату».",
                build_crypto_invoice_keyboard(parsed["orderId"], invoice.pay_url),
            )
        except Exception:
            logging.exception("Crypto invoice create error")
            await edit_or_reply(
                callback,
                "Не удалось создать инвойс Crypto Pay. Проверьте токен/настройки и попробуйте снова.",
                WITH_BACK_TO_MENU,
            )
        return

    already_paid = str(order.get("status", "")).startswith("paid")
    if not already_paid:
        pricing = await get_effective_discount_for_game(user_id, str(order.get("gameType")))
        discount = int(pricing["discount"])
        amount = calc_price(CONFIG.prices.sub if parsed["type"] == "sub" else CONFIG.prices.single, discount)

        if pricing["stats"].wallet_balance < amount:
            await edit_or_reply(
                callback,
                f"Недостаточно средств на балансе.\nВаш баланс: ${pricing['stats'].wallet_balance}\n"
                f"Требуется: ${amount}\n\nПожалуйста, пополните счёт.",
                WITH_BACK_TO_MENU,
            )
            return

        finalized = False
        try:
            await DB.finalize_paid_order(parsed["orderId"], user_id, f"paid_{parsed['type']}", amount, discount)
            finalized = True
        except DBError as exc:
            if str(exc) == "ORDER_ALREADY_PAID":
                already_paid = True
            elif str(exc) == "INSUFFICIENT_FUNDS":
                await edit_or_reply(
                    callback,
                    f"Недостаточно средств на балансе.\nВаш баланс: ${pricing['stats'].wallet_balance}\n"
                    f"Требуется: ${amount}\n\nПожалуйста, пополните счёт.",
                    WITH_BACK_TO_MENU,
                )
                return
            elif str(exc) in {"ORDER_NOT_FOUND", "ORDER_USER_MISMATCH"}:
                await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
                return
            else:
                logging.exception("Payment finalize error")
                await edit_or_reply(callback, "Ошибка обработки оплаты.", WITH_BACK_TO_MENU)
                return

        if finalized:
            await DB.add_referral_reward(user_id, amount)
            await DB.log_action(user_id, "pay_success", f"${amount}")

    await deliver_final_order(
        callback,
        parsed["orderId"],
        order,
        "Оплата уже подтверждена. Собираю финальный файл..."
        if already_paid
        else "Оплата прошла! Собираю финальный файл...",
    )


@router.callback_query(F.data == "profile")
async def on_profile(callback: CallbackQuery) -> None:
    await callback.answer()
    user_id = callback.from_user.id
    lang = await get_user_lang(user_id)
    stats = await DB.get_user_stats(user_id)
    bot_username = await get_bot_username(require_bot(callback))
    msg_text = build_profile_message(user_id, stats.orders_paid, stats.wallet_balance, bot_username, lang=lang)

    profile_path = BOT_ASSETS_DIR / "profile.png"
    keyboard = _inline_keyboard(
        [
            [InlineKeyboardButton(text=t(lang, "top_up"), callback_data="top_up_balance")],
            [InlineKeyboardButton(text=t(lang, "menu_home"), callback_data="main_menu")],
        ]
    )
    message = _callback_message(callback)
    await _safe_delete_message(message)

    try:
        cached_id = await DB.get_asset(ASSETS["PROFILE"])
        if cached_id:
            if message is not None:
                await message.answer_photo(cached_id, caption=msg_text, reply_markup=keyboard)
            else:
                await require_bot(callback).send_photo(callback.from_user.id, cached_id, caption=msg_text, reply_markup=keyboard)
            return
        if profile_path.exists():
            if message is not None:
                sent = await message.answer_photo(FSInputFile(profile_path), caption=msg_text, reply_markup=keyboard)
            else:
                sent = await require_bot(callback).send_photo(
                    callback.from_user.id,
                    FSInputFile(profile_path),
                    caption=msg_text,
                    reply_markup=keyboard,
                )
            if sent.photo:
                await DB.set_asset(ASSETS["PROFILE"], sent.photo[-1].file_id)
            return
    except Exception:
        logging.exception("Error sending profile")
    await _reply_from_callback(callback, msg_text, keyboard)


@router.callback_query(F.data == "top_up_balance")
async def on_top_up_balance(callback: CallbackQuery) -> None:
    await callback.answer()
    msg = (
        "<b>Пополнение баланса</b>\n\n"
        "Для пополнения баланса переведите средства на один из кошельков ниже:\n\n"
        f"🔹 <b>USDT TRC-20:</b>\n<code>{CONFIG.wallets.usdt_trc20}</code>\n\n"
        f"🔸 <b>BTC:</b>\n<code>{CONFIG.wallets.btc}</code>\n\n"
        "После оплаты нажмите кнопку <b>«Я оплатил»</b>. Мы проверим транзакцию и зачислим баланс."
    )
    await edit_or_reply(
        callback,
        msg,
        _inline_keyboard(
            [
                [InlineKeyboardButton(text="✅ Я оплатил", callback_data="i_paid")],
                [InlineKeyboardButton(text="🔙 Назад", callback_data="profile")],
            ]
        ),
    )


@router.callback_query(F.data == "i_paid")
async def on_i_paid(callback: CallbackQuery) -> None:
    await callback.answer()
    user = callback.from_user
    await DB.log_action(user.id, "click_i_paid")
    await edit_or_reply(
        callback,
        "<b>Заявка отправлена!</b>\n\nАдминистратор скоро проверит платёж и зачислит средства на ваш баланс. "
        "Обычно это занимает от 5 до 30 минут.",
        _inline_keyboard([[InlineKeyboardButton(text="🏠 Главное меню", callback_data="main_menu")]]),
    )

    safe_first_name = escape(user.first_name or "Без имени")
    safe_username = escape(user.username or "нет")
    admin_msg = (
        "🔔 <b>Новое уведомление об оплате!</b>\n\n"
        f"<b>От:</b> {safe_first_name} (@{safe_username})\n"
        f"<b>ID:</b> <code>{user.id}</code>\n\n"
        "Проверьте входящие транзакции."
    )
    try:
        await require_bot(callback).send_message(CONFIG.admin_telegram_id, admin_msg)
    except Exception:
        logging.exception("Failed to notify admin")


async def approve_manual_order(bot: Bot, order_id: str) -> dict[str, Any]:
    order = await DB.get_order(order_id)
    if not order:
        return {"ok": False, "message": "Заказ не найден."}

    config = order.get("config", {})
    manual_payment = config.get("manualPayment", {}) if isinstance(config, dict) else {}
    payment_type = manual_payment.get("type")
    if payment_type not in {"single", "sub"}:
        payment_type = "single"

    amount = manual_payment.get("amount", 0)
    discount = manual_payment.get("discount", 0)
    try:
        normalized_amount = max(0, int(amount))
    except (TypeError, ValueError):
        normalized_amount = 0
    try:
        normalized_discount = max(0, int(discount))
    except (TypeError, ValueError):
        normalized_discount = 0

    if not str(order.get("status", "")).startswith("paid"):
        await DB.mark_paid(order_id, f"paid_manual_{payment_type}", normalized_amount, normalized_discount)
        await DB.update_order_config(
            order_id,
            {
                "manualPayment": {
                    **(manual_payment if isinstance(manual_payment, dict) else {}),
                    "state": "approved",
                    "approvedAt": datetime.now(UTC).isoformat(),
                }
            },
        )
        await DB.log_action(order["userId"], "admin_manual_payment_approved", f"{order_id}:${normalized_amount}")
        if normalized_amount > 0:
            await DB.add_referral_reward(int(order["userId"]), normalized_amount)

    fresh_order = await DB.get_order(order_id)
    if not fresh_order:
        return {"ok": False, "message": "Заказ не найден."}

    await asyncio.sleep(FINAL_DELIVERY_DELAY_SECONDS)
    try:
        final_path = await build_final_order_path(order_id, fresh_order)
    except Exception:
        logging.exception("Failed to build final playable for manual approval")
        await DB.log_action(int(order["userId"]), "manual_approve_build_failed", order_id)
        return {"ok": False, "message": "Ошибка сборки финального файла. Проверьте логи builder и попробуйте снова."}
    if not final_path:
        return {"ok": False, "message": "Ошибка сборки файла."}

    try:
        user_lang = await DB.get_user_language(int(order["userId"]))
        await bot.send_document(
            int(order["userId"]),
            FSInputFile(final_path),
            caption=localize_text("Ваш файл готов.", user_lang),
        )
        return {"ok": True, "message": f"Заказ {order_id} одобрен. Файл отправлен пользователю {order['userId']}."}
    except Exception:
        logging.exception("Failed to send granted playable")
        return {"ok": False, "message": "Не удалось отправить файл пользователю."}

@router.callback_query(F.data.regexp(r"^admin_manual_(approve|reject)_"))
async def on_admin_manual(callback: CallbackQuery) -> None:
    if callback.from_user.id != CONFIG.admin_telegram_id:
        lang = await get_user_lang(callback.from_user.id)
        await callback.answer(localize_text("Недостаточно прав.", lang), show_alert=True)
        return
    match = re.match(r"^admin_manual_(approve|reject)_(.+)$", callback.data or "")
    if not match:
        lang = await get_user_lang(callback.from_user.id)
        await callback.answer(localize_text("Некорректная команда.", lang), show_alert=True)
        return
    action, order_id = match.group(1), match.group(2)
    await callback.answer()

    if action == "approve":
        await edit_or_reply(callback, f"⏳ Одобряю заказ {order_id}. Собираю финальный файл...", MAIN_MENU_NAV)
        result = await approve_manual_order(require_bot(callback), order_id)
        await edit_or_reply(callback, result["message"], MAIN_MENU_NAV)
        return

    order = await DB.get_order(order_id)
    if not order:
        await edit_or_reply(callback, "Заказ не найден.", WITH_BACK_TO_MENU)
        return

    config = order.get("config", {})
    manual_payment = config.get("manualPayment", {}) if isinstance(config, dict) else {}
    await DB.update_order_config(
        order_id,
        {
            "manualPayment": {
                **(manual_payment if isinstance(manual_payment, dict) else {}),
                "state": "rejected",
                "rejectedAt": datetime.now(UTC).isoformat(),
            }
        },
    )
    await DB.set_order_status(order_id, "manual_rejected")
    await DB.log_action(int(order["userId"]), "admin_manual_payment_rejected", order_id)
    try:
        await require_bot(callback).send_message(
            int(order["userId"]),
            f"Оплата по заказу {order_id} отклонена. Проверьте данные и отправьте новое подтверждение.",
        )
    except Exception:
        logging.exception("Failed to notify user about rejection")

    await edit_or_reply(callback, f"Заказ {order_id} отклонён. Пользователь уведомлён.", MAIN_MENU_NAV)


@router.message(Command("grantorder"))
async def on_grantorder(message: Message) -> None:
    if message.from_user is None or message.from_user.id != CONFIG.admin_telegram_id:
        return
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2 or not parts[1].strip():
        await message.answer("Использование: /grantorder <orderId>")
        return
    result = await approve_manual_order(require_bot(message), parts[1].strip())
    await message.answer(result["message"])


@router.message(Command("addbalance"))
async def on_addbalance(message: Message) -> None:
    if message.from_user is None or message.from_user.id != CONFIG.admin_telegram_id:
        return
    parts = (message.text or "").split(maxsplit=2)
    if len(parts) < 3:
        await message.answer("Использование: /addbalance <userId> <amount>")
        return

    raw_user_id, raw_amount = parts[1], parts[2]
    if not raw_user_id.isdigit():
        await message.answer("Некорректный userId. Используйте числовой Telegram ID.")
        return
    try:
        amount = float(raw_amount)
    except ValueError:
        amount = -1
    if amount <= 0:
        await message.answer("Сумма должна быть положительным числом.")
        return

    target_user_id = int(raw_user_id)
    try:
        await DB.increment_user_balance(target_user_id, amount)
        await DB.log_action(target_user_id, "admin_add_balance", f"Added ${amount}")
        await message.answer(f"Баланс пользователя {target_user_id} увеличен на ${amount}")
        try:
            target_lang = await DB.get_user_language(target_user_id)
            await require_bot(message).send_message(
                target_user_id,
                localize_text(f"Ваш баланс пополнен на <b>${amount}</b>.", target_lang),
            )
        except Exception:
            pass
    except DBError:
        await message.answer("Ошибка: пользователь не найден или не удалось обновить БД.")


@router.callback_query(F.data == "ref_system")
async def on_ref_system(callback: CallbackQuery) -> None:
    await callback.answer()
    lang = await get_user_lang(callback.from_user.id)
    await DB.log_action(callback.from_user.id, "referral_open")
    stats = await DB.get_user_stats(callback.from_user.id)
    bot_username = await get_bot_username(require_bot(callback))
    link = f"t.me/{bot_username}?start={callback.from_user.id}"
    msg = (
        f"{t(lang, 'ref_title')}\n"
        f"{t(lang, 'ref_link')}: {link}\n"
        f"{t(lang, 'ref_invited')}: {stats.referrals_count}\n"
        f"{t(lang, 'ref_balance')}: ${stats.wallet_balance}"
    )
    await edit_or_reply(callback, msg, build_main_menu_nav(lang))


@router.message()
async def on_any_message(message: Message) -> None:
    if message.from_user is None:
        return
    user_id = message.from_user.id
    session = await get_session(user_id)

    pending = session.get("pendingManualPayment")
    if isinstance(pending, dict):
        text = (message.text or "").strip()
        has_photo = bool(message.photo)
        has_document = message.document is not None

        if text.lower() == "/cancel":
            session.pop("pendingManualPayment", None)
            await save_session(user_id, session)
            await DB.log_action(user_id, "manual_payment_proof_cancelled", str(pending.get("orderId", "")))
            await answer_user(message, "Запрос на ручную оплату отменён.", reply_markup=MAIN_MENU_NAV)
            return

        if not text and not has_photo and not has_document:
            await answer_user(message, "Отправьте TX hash (текст) или скриншот (фото/документ).")
            return

        order_id = str(pending.get("orderId", ""))
        order = await DB.get_order(order_id)
        if not order or int(order.get("userId", 0)) != user_id:
            session.pop("pendingManualPayment", None)
            await save_session(user_id, session)
            await answer_user(message, "Заказ не найден. Начните заново из главного меню.", reply_markup=MAIN_MENU_NAV)
            return
        if is_order_cancelled(order):
            session.pop("pendingManualPayment", None)
            await save_session(user_id, session)
            await answer_user(message, CANCELLED_ORDER_TEXT, reply_markup=build_cancelled_order_keyboard())
            return

        proof_type = "text" if text else "photo" if has_photo else "document"
        proof_text = text[:1000] if text else ""

        await DB.update_order_config(
            order_id,
            {
                "manualPayment": {
                    "provider": "direct_wallet",
                    "type": pending.get("paymentType", "single"),
                    "amount": pending.get("amount", 0),
                    "state": "pending_admin_review",
                    "proofType": proof_type,
                    "proofText": proof_text or None,
                    "proofMessageId": message.message_id,
                    "submittedAt": datetime.now(UTC).isoformat(),
                }
            },
        )
        await DB.set_order_status(order_id, f"manual_review_{pending.get('paymentType', 'single')}")
        await DB.log_action(
            user_id,
            "manual_payment_proof_submitted",
            f"{order_id}:{pending.get('paymentType', 'single')}:${pending.get('amount', 0)}",
        )

        safe_first_name = escape(message.from_user.first_name or "Без имени")
        safe_username = escape(message.from_user.username or "нет")
        safe_proof = escape(proof_text) if proof_text else "(смотрите пересланное сообщение)"
        admin_message = (
            "<b>Получено подтверждение ручной оплаты</b>\n\n"
            f"<b>Заказ:</b> <code>{escape(order_id)}</code>\n"
            f"<b>Пользователь:</b> {safe_first_name} (@{safe_username})\n"
            f"<b>ID пользователя:</b> <code>{user_id}</code>\n"
            f"<b>Тип:</b> {pending.get('paymentType', 'single')}\n"
            f"<b>Сумма:</b> ${pending.get('amount', 0)}\n"
            f"<b>Доказательство:</b> {safe_proof}\n\n"
            f"Или используйте /grantorder {escape(order_id)} для ручной выдачи."
        )

        try:
            await require_bot(message).send_message(
                CONFIG.admin_telegram_id,
                admin_message,
                reply_markup=_inline_keyboard(
                    [
                        [InlineKeyboardButton(text="✅ Одобрить", callback_data=f"admin_manual_approve_{order_id}")],
                        [InlineKeyboardButton(text="❌ Отклонить", callback_data=f"admin_manual_reject_{order_id}")],
                    ]
                ),
            )
            await require_bot(message).forward_message(CONFIG.admin_telegram_id, message.chat.id, message.message_id)
        except Exception:
            logging.exception("Failed to notify admin about manual payment proof")

        session.pop("pendingManualPayment", None)
        await save_session(user_id, session)
        await answer_user(message, "Подтверждение отправлено админу. После проверки вы получите готовый файл.", reply_markup=MAIN_MENU_NAV)
        return

    wizard = get_wizard(session)
    if wizard:
        if wizard_expired(wizard):
            clear_wizard(session)
            await save_session(user_id, session)
            await answer_user(message, "Время ожидания истекло. Начните заказ заново из главного меню.", reply_markup=MAIN_MENU_NAV)
            return

        stage = wizard.get("stage")
        text = (message.text or "").strip()
        if stage == "custom_geo_desc":
            if not text:
                await answer_user(message, "Отправьте описание вашего GEO текстовым сообщением.")
                return
            description = re.sub(r"\s+", " ", text).strip()[:MAX_CUSTOM_GEO_DESCRIPTION]
            if not description:
                clear_wizard(session)
                await save_session(user_id, session)
                await answer_user(message, "Запрос на кастомный GEO пустой. Начните заново из меню.", reply_markup=MAIN_MENU_NAV)
                return

            config = get_session_config(session)
            order_id = f"custom_{user_id}_{int(datetime.now().timestamp() * 1000)}"
            await DB.create_order(order_id, user_id, str(config.get("game", "railroad")), "custom", {"description": description})
            await DB.set_order_status(order_id, "custom_pending")
            await DB.log_action(user_id, "request_custom_geo", description)
            clear_wizard(session)
            await save_session(user_id, session)
            await answer_user(
                message,
                "📩 <b>Ваш запрос отправлен админу!</b>\nМы свяжемся с вами в ближайшее время.",
                reply_markup=MAIN_MENU_NAV,
            )
            return

        if stage == "cta_url":
            if not text:
                await answer_user(message, "Отправьте CTA-ссылку текстом.")
                return
            cta_url = normalize_cta_url(text)
            if cta_url:
                config = get_session_config(session)
                config["clickUrl"] = cta_url
                await DB.log_action(user_id, "set_click_url", cta_url)
                clear_wizard(session)
                await save_session(user_id, session)
                summary = build_order_summary(config)
                await answer_user(message, "✅ <b>CTA-ссылка сохранена</b>")
                await answer_user(
                    message,
                    summary or "<b>Проверьте настройки заказа и создайте превью.</b>",
                    reply_markup=_inline_keyboard(
                        [
                            [InlineKeyboardButton(text="🚀 СОЗДАТЬ ПРЕВЬЮ", callback_data="gen_preview")],
                            [InlineKeyboardButton(text="🏠 Главное меню", callback_data="main_menu")],
                        ]
                    ),
                )
                return

            attempts = int(wizard.get("attempts", 0)) + 1
            if attempts >= 3:
                clear_wizard(session)
                await save_session(user_id, session)
                await answer_user(message, "CTA-ссылка не задана. Начните заказ заново из главного меню.", reply_markup=MAIN_MENU_NAV)
                return
            set_wizard(session, "cta_url", attempts=attempts)
            await save_session(user_id, session)
            await answer_user(message, "Некорректная ссылка. Отправьте валидный http/https URL, например https://example.com")
            return

        if stage == "starting_balance":
            parsed_balance = parse_starting_balance(text)
            if parsed_balance is not None:
                config = get_session_config(session)
                config["startingBalance"] = parsed_balance
                await DB.log_action(user_id, "set_starting_balance", str(parsed_balance))
                set_wizard(session, "cta_url", attempts=0)
                await save_session(user_id, session)
                await answer_user(message, f"✅ Стартовый баланс сохранен: <b>{parsed_balance}</b>")
                await answer_user(
                    message,
                    "🔗 <b>Отправьте CTA-ссылку для редиректа</b>\nПример: <code>https://example.com</code>",
                )
                return

            attempts = int(wizard.get("attempts", 0)) + 1
            if attempts >= 3:
                config = get_session_config(session)
                fallback = get_default_balance_for_game(config.get("game"))
                config["startingBalance"] = fallback
                await DB.log_action(user_id, "set_starting_balance_fallback", str(fallback))
                set_wizard(session, "cta_url", attempts=0)
                await save_session(user_id, session)
                await answer_user(
                    message,
                    f"Использован баланс по умолчанию: <b>{fallback}</b>. Теперь отправьте CTA-ссылку."
                )
                await answer_user(
                    message,
                    "🔗 <b>Отправьте CTA-ссылку для редиректа</b>\nПример: <code>https://example.com</code>",
                )
                return

            set_wizard(session, "starting_balance", attempts=attempts)
            await save_session(user_id, session)
            await answer_user(
                message,
                "Введите корректное число для стартового баланса, например <code>1000</code>.",
                reply_markup=_inline_keyboard(
                    [[InlineKeyboardButton(text="Пропустить (по умолчанию)", callback_data="skip_starting_balance")]]
                ),
            )
            return


@router.callback_query()
async def on_callback_fallback(callback: CallbackQuery) -> None:
    session = await get_session(callback.from_user.id)
    wizard = get_wizard(session)
    if wizard and wizard.get("stage") == "custom_geo_desc":
        lang = await get_user_lang(callback.from_user.id)
        await callback.answer(localize_text("Отправьте описание вашего GEO текстовым сообщением.", lang), show_alert=False)
        return
    if wizard and wizard.get("stage") == "cta_url":
        lang = await get_user_lang(callback.from_user.id)
        await callback.answer(localize_text("Отправьте CTA-ссылку текстом.", lang), show_alert=False)
        return
    if wizard and wizard.get("stage") == "starting_balance":
        lang = await get_user_lang(callback.from_user.id)
        await callback.answer(localize_text("Отправьте стартовый баланс числом.", lang), show_alert=False)
        return


@router.errors()
async def on_error(event: Any) -> None:
    update = getattr(event, "update", None)
    exception = getattr(event, "exception", None)
    error = exception if isinstance(exception, Exception) else RuntimeError(str(exception))
    user_id: int | None = None
    callback_data: str | None = None
    update_type = "unknown"

    if hasattr(update, "callback_query") and getattr(update, "callback_query", None):
        callback = update.callback_query
        callback_data = getattr(callback, "data", None)
        user = getattr(callback, "from_user", None)
        if user is not None:
            user_id = user.id
            update_type = "callback_query"
    elif hasattr(update, "message") and getattr(update, "message", None):
        msg = update.message
        user = getattr(msg, "from_user", None)
        if user is not None:
            user_id = user.id
            update_type = "message"

    logging.error(
        "[BotError] updateType=%s userId=%s callbackData=%s message=%s",
        update_type,
        user_id,
        callback_data,
        str(error),
    )
    if user_id is not None:
        await DB.log_action(user_id, "bot_error", f"{update_type}: {error}")


async def start() -> None:
    logging.basicConfig(
        level=getattr(logging, CONFIG.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    await cleanup_temp()
    await DB.ensure_runtime_schema()
    bot = Bot(
        token=CONFIG.bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dispatcher = Dispatcher()
    block_banned = BlockBannedMiddleware()
    dispatcher.message.middleware(block_banned)
    dispatcher.callback_query.middleware(block_banned)
    dispatcher.include_router(router)
    await dispatcher.start_polling(bot, polling_timeout=CONFIG.polling_timeout)


if __name__ == "__main__":
    asyncio.run(start())

