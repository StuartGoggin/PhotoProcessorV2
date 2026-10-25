"""Unshipped CPU-only overlap image-feature experiment; not export authority."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("feature_experiment", Path(__file__).with_name("feature-cache-experiment.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.main(cache_enabled=True)
