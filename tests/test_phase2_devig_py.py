"""Python parity tests for Phase 2 Power De-vig."""

from __future__ import annotations

import pytest

from src.evaluate import _american_no_vig_pair, power_devig_pair


def test_power_devig_pair_matches_js_and_corrects_favorite_longshot_bias() -> None:
    fav_imp = 220.0 / 320.0
    dog_imp = 100.0 / 285.0
    prop_fav = fav_imp / (fav_imp + dog_imp)

    pair = power_devig_pair(dog_imp, fav_imp)
    assert pair is not None
    fair_dog, fair_fav = pair
    assert fair_dog + fair_fav == pytest.approx(1.0, abs=1e-10)
    # Favorite-longshot correction: Power De-vig gives favorite higher fair prob than proportional.
    assert fair_fav > prop_fav
    # Verify exact Power De-vig identity: dog_imp^k + fav_imp^k = 1.
    import math
    k = math.log(fair_fav) / math.log(fav_imp)
    assert k > 1.0
    assert (dog_imp ** k) + (fav_imp ** k) == pytest.approx(1.0, abs=1e-10)
    assert fair_fav == pytest.approx(0.671489, abs=1e-5)

    from_odds = _american_no_vig_pair(185, -220)
    assert from_odds is not None
    assert from_odds[0] == pytest.approx(fair_dog, abs=1e-10)
    assert from_odds[1] == pytest.approx(fair_fav, abs=1e-10)
    # Reject invalid American odds in (-100, 100).
    assert _american_no_vig_pair(50, -110) is None
