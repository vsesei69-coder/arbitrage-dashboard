"""
NEYTIS Arbitrage API — бэкенд для дашборда арбитража.
Два режима: personal (ключи пользователя) и union (общий фонд Союза).
"""
import logging
from datetime import datetime, timezone
from enum import Enum

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

logger = logging.getLogger("neytis.arbitrage")

router = APIRouter(prefix="/arbitrage", tags=["arbitrage"])


class ArbMode(str, Enum):
    PERSONAL = "personal"
    UNION = "union"


class ArbExecuteRequest(BaseModel):
    pair: str
    amount: float
    from_exchange: str
    to_exchange: str
    mode: ArbMode = ArbMode.PERSONAL
    connection_type: str = "api"


class ArbitrageEngine:
    """Ядро арбитража — сканирует спреды, исполняет ордера."""

    def __init__(self):
        self._active_spreads: list[dict] = []
        self._trades: list[dict] = []
        self._union_balance: float = 0.0
        self._split_participant: float = 0.60
        self._split_union: float = 0.40
        self._real_engine = None

    def set_real_engine(self, engine):
        self._real_engine = engine

    def get_real_engine(self):
        return self._real_engine

    async def get_spreads(self, mode: ArbMode) -> list[dict]:
        try:
            from bot.exchange.universal_exchange_adapter import UniversalExchangeAdapter
            adapter = UniversalExchangeAdapter()
            connected = await adapter.get_connected_exchanges(
                scope="union" if mode == ArbMode.UNION else "personal"
            )
            spreads = []
            pairs = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "ARB/USDT", "DOGE/USDT"]
            for pair in pairs:
                prices = {}
                for ex in connected:
                    try:
                        ticker = await adapter.fetch_ticker(ex, pair)
                        prices[ex] = ticker.get("last", 0)
                    except (ValueError, KeyError, ConnectionError):
                        continue
                if len(prices) >= 2:
                    sorted_p = sorted(prices.items(), key=lambda x: x[1])
                    low_ex, low_price = sorted_p[0]
                    high_ex, high_price = sorted_p[-1]
                    spread_pct = ((high_price - low_price) / low_price) * 100 if low_price > 0 else 0
                    if spread_pct > 0.05:
                        spreads.append({
                            "pair": pair,
                            "from_ex": low_ex,
                            "to_ex": high_ex,
                            "spread_pct": round(spread_pct, 4),
                            "volume_24h": 0,
                            "status": "active" if spread_pct > 0.2 else "watching"
                        })
            return spreads
        except ImportError:
            logger.warning("UniversalExchangeAdapter not available, returning empty")
            return []

    async def get_balances(self, mode: ArbMode) -> list[dict]:
        try:
            from bot.exchange.universal_exchange_adapter import UniversalExchangeAdapter
            adapter = UniversalExchangeAdapter()
            if mode == ArbMode.UNION:
                total = await adapter.get_union_fund_balance()
                return [{"exchange": "Union Fund", "balance_usd": total, "allocated_pct": 100}]
            connected = await adapter.get_connected_exchanges(scope="personal")
            balances = []
            total = 0
            for ex in connected:
                try:
                    bal = await adapter.fetch_balance(ex)
                    usd = bal.get("total_usd", 0)
                    total += usd
                    balances.append({"exchange": ex, "balance_usd": usd, "allocated_pct": 0})
                except (ValueError, KeyError, ConnectionError):
                    continue
            for b in balances:
                b["allocated_pct"] = round((b["balance_usd"] / total) * 100, 1) if total > 0 else 0
            return balances
        except ImportError:
            return []

    async def get_pnl(self, mode: ArbMode) -> dict:
        total_pnl = sum(t.get("profit", 0) for t in self._trades)
        if mode == ArbMode.UNION:
            return {
                "total": total_pnl,
                "participant_share": round(total_pnl * self._split_participant, 2),
                "union_share": round(total_pnl * self._split_union, 2),
                "history": [t.get("profit", 0) for t in self._trades[-20:]]
            }
        return {"total": total_pnl, "history": [t.get("profit", 0) for t in self._trades[-20:]]}

    async def execute(self, req: ArbExecuteRequest) -> dict:
        if req.mode == ArbMode.UNION:
            raise HTTPException(400, "Union fund managed by Neytis only")
        logger.warning(
            "SIMULATION ONLY: %s %s -> %s amount=%.2f via %s",
            req.pair, req.from_exchange, req.to_exchange, req.amount, req.connection_type,
        )
        trade = {
            "id": f"T-{len(self._trades)+1:04d}",
            "pair": req.pair,
            "from_exchange": req.from_exchange,
            "to_exchange": req.to_exchange,
            "amount": req.amount,
            "spread": 0,
            "profit": 0,
            "status": "simulation",
            "simulation": True,
            "connection_type": req.connection_type,
            "time": datetime.now(timezone.utc).strftime("%H:%M:%S"),
        }
        self._trades.append(trade)
        return trade

    async def get_agents_status(self, mode: ArbMode) -> dict:
        if self._real_engine is None:
            return {"agents": [], "status": "engine_not_running"}
        try:
            return self._real_engine.get_agents_status(mode)
        except (AttributeError, TypeError, RuntimeError) as e:
            logger.error("get_agents_status failed: %s", e)
            return {"agents": [], "status": "error", "error": str(e)}

    async def get_risks(self, mode: ArbMode) -> dict:
        if self._real_engine is None:
            return {"metrics": [], "status": "engine_not_running"}
        try:
            return self._real_engine.get_risks(mode)
        except (AttributeError, TypeError, RuntimeError) as e:
            logger.error("get_risks failed: %s", e)
            return {"metrics": [], "status": "error", "error": str(e)}


_engine = ArbitrageEngine()


@router.get("/spreads")
async def api_get_spreads(mode: ArbMode = Query(ArbMode.PERSONAL)) -> dict:  # noqa: B008
    items = await _engine.get_spreads(mode)
    return {"items": items, "mode": mode.value}


@router.get("/balances")
async def api_get_balances(mode: ArbMode = Query(ArbMode.PERSONAL)) -> dict:  # noqa: B008
    balances = await _engine.get_balances(mode)
    return {"balances": balances, "mode": mode.value}


@router.get("/pnl")
async def api_get_pnl(mode: ArbMode = Query(ArbMode.PERSONAL)) -> dict:  # noqa: B008
    return await _engine.get_pnl(mode)


@router.get("/agents")
async def api_get_agents(mode: ArbMode = Query(ArbMode.PERSONAL)) -> dict:  # noqa: B008
    result = await _engine.get_agents_status(mode)
    result["mode"] = mode.value
    return result


@router.get("/risks")
async def api_get_risks(mode: ArbMode = Query(ArbMode.PERSONAL)) -> dict:  # noqa: B008
    result = await _engine.get_risks(mode)
    result["mode"] = mode.value
    return result


@router.get("/trades/recent")
async def api_get_recent_trades(mode: ArbMode = Query(ArbMode.PERSONAL), limit: int = 20) -> dict:  # noqa: B008
    trades = _engine._trades[-limit:]
    return {"trades": trades, "mode": mode.value}


@router.post("/execute")
async def api_execute_arbitrage(req: ArbExecuteRequest) -> dict:
    trade = await _engine.execute(req)
    return {"status": "ok", "trade": trade, "simulation": True}


@router.get("/engine")
async def api_get_engine_status() -> dict:
    running = _engine.get_real_engine() is not None
    return {"engine_running": running, "status": "engine_not_running" if not running else "running"}
