# Runs oec with the terminal's features hidden, so that it drives the
# terminal without its extended attribute buffer. Arguments as for
# python -m oec.
import oec.__main__

oec.__main__.get_features = lambda interface, device_address: {}
oec.__main__.main()
