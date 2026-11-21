# Installing Bay on Linux

Bay for Linux runs on x86_64 distributions with glibc. Installing from a package repository keeps Bay up to date with
the rest of the system. Every package and repository is signed with Bay's key,
`https://baybrowser.in/linux/bay.asc`.

## Debian, Ubuntu, Linux Mint, Pop!_OS

```bash
curl -fsSL https://baybrowser.in/linux/bay.gpg | sudo tee /usr/share/keyrings/bay.gpg >/dev/null
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/bay.gpg] https://baybrowser.in/linux/apt ./" \
  | sudo tee /etc/apt/sources.list.d/bay.list
sudo apt update && sudo apt install bay
```

## Fedora, RHEL, CentOS Stream

```bash
sudo curl -fsSL -o /etc/yum.repos.d/bay.repo https://baybrowser.in/linux/bay.repo
sudo dnf install bay
```

## openSUSE

```bash
sudo zypper addrepo https://baybrowser.in/linux/bay.repo
sudo zypper install bay
```

## Flatpak (any distribution)

Bay is `in.baybrowser.bay` on Flathub, so GNOME Software and KDE Discover list it too:

```bash
flatpak install flathub in.baybrowser.bay
```

## Snap (any distribution with snapd)

```bash
sudo snap install bay
```

## Arch, Manjaro, EndeavourOS

Bay is `bay-bin` in the AUR:

```bash
yay -S bay-bin
```

## NixOS

Bay is `bay` in nixpkgs: add `pkgs.bay` to `environment.systemPackages`, or try it with `nix run nixpkgs#bay`. Each
release also has `bay-<version>-nixos-x64.nar.zst`, with a README showing how to import it, for a version nixpkgs
doesn't have yet.

## Any other distribution: AppImage or tarball

Download `Bay-<version>-x86_64.AppImage` from the latest Linux release on GitHub, `chmod +x` it and run it. It updates
through zsync (AppImageUpdate, Gear Lever or AppImageLauncher). On Ubuntu 23.10 and later, AppArmor blocks the
sandbox for AppImages: start it once from a terminal and run the two commands it prints to install Bay's profile.

`bay-<version>-linux-x64.tar.xz` holds the same `/opt/bay` tree the packages install. Run `opt/bay/bay-wrapper` from
where you unpack it.

## Checking a download

```bash
gpg --import bay.asc
gpg --verify bay-<version>-linux-SHA256SUMS.asc
sha256sum --ignore-missing -c bay-<version>-linux-SHA256SUMS
```
