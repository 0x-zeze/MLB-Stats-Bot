from src.utils import confidence_label


def test_confidence_label_single_arg_thresholds():
    assert confidence_label(0.53) == "Low"
    assert confidence_label(0.55) == "Medium"
    assert confidence_label(0.59) == "High"


def test_confidence_label_uses_calibrated_probability_when_provided():
    assert confidence_label(0.62, calibrated_prob=0.54) == "Medium"
    assert confidence_label(0.62, calibrated_prob=0.53) == "Low"
