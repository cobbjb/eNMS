# -*- coding: utf-8 -*-
# Generated by Django 1.11.7 on 2017-11-22 14:20
from __future__ import unicode_literals

from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
    ]

    operations = [
        migrations.CreateModel(
            name='Device',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('hostname', models.CharField(max_length=30)),
                ('ip_address', models.CharField(max_length=16)),
                ('vendor', models.CharField(max_length=30)),
            ],
        ),
    ]
