"""Builds the app's signing keystore from one secret passphrase.

Android only installs an update over the old app when both are signed with
the same key. The private key is derived from the HUMAN_SIGNING_PASSPHRASE
secret (kept in GitHub Actions secrets, never in this repo); the matching
public certificate is committed at android/signing/human-cert.pem.

  python tools/signing.py cert OUT.pem          # one time: create the public certificate
  python tools/signing.py keystore CERT.pem OUT.p12 STOREPASS
                                                # CI: rebuild the keystore for signing
Both read the passphrase from the HUMAN_SIGNING_PASSPHRASE environment variable.
"""
import datetime
import os
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

# Order of the P-256 group.
P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


def private_key():
    phrase = os.environ.get('HUMAN_SIGNING_PASSPHRASE', '')
    if len(phrase) < 24:
        sys.exit('HUMAN_SIGNING_PASSPHRASE must be set (24+ characters).')
    okm = HKDF(algorithm=hashes.SHA256(), length=48, salt=b'human-android-signing-v1',
               info=b'p256-private-scalar').derive(phrase.encode('utf-8'))
    scalar = int.from_bytes(okm, 'big') % (P256_N - 1) + 1
    return ec.derive_private_key(scalar, ec.SECP256R1())


def make_cert(out_path):
    key = private_key()
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Human'),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'NoorJ29')])
    start = datetime.datetime(2026, 10, 30, tzinfo=datetime.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(0x4855_4D41_4E)
            .not_valid_before(start)
            .not_valid_after(start + datetime.timedelta(days=365 * 50))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    with open(out_path, 'wb') as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    print('certificate written to', out_path)


def make_keystore(cert_path, out_path, storepass):
    key = private_key()
    with open(cert_path, 'rb') as f:
        cert = x509.load_pem_x509_certificate(f.read())
    pub = lambda k: k.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    if pub(cert.public_key()) != pub(key.public_key()):
        sys.exit('The passphrase does not match the committed certificate.')
    data = pkcs12.serialize_key_and_certificates(
        b'human', key, cert, None, serialization.BestAvailableEncryption(storepass.encode('utf-8')))
    with open(out_path, 'wb') as f:
        f.write(data)
    print('keystore written to', out_path)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'cert':
        make_cert(sys.argv[2])
    elif len(sys.argv) == 5 and sys.argv[1] == 'keystore':
        make_keystore(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        sys.exit(__doc__)
