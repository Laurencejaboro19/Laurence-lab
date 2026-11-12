"""Entry point: `python -m sextant` starts the Telegram bot."""
import logging

from .config import load_config, require_runtime


def main() -> None:
    cfg = load_config()
    logging.basicConfig(level=cfg.log_level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # request URLs can contain the bot token
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    require_runtime(cfg)
    from .bot.app import run

    run(cfg)


if __name__ == "__main__":
    main()
